"""Polite, bounded downloads from the supplier websites listed in data/suppliers.json.

Rules:
- Only hosts listed in the source's allowed_hosts (plus the source's own host) are contacted.
- Only public internet addresses: the collector runs inside a home network, so it
  refuses anything that resolves to a private or local address.
- robots.txt is respected, with a delay between requests to the same host.
- Downloads are capped at MAX_FILE_MB.
- No JavaScript is run. Sites that only offer datasheets through scripts or
  sign-in forms need a direct PDF link added as a source instead.
"""

from __future__ import annotations

import ipaddress
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

MAX_REDIRECTS = 5


class FetchError(Exception):
    pass


@dataclass
class Response:
    url: str
    status: int
    headers: dict
    body: bytes


def canonical_url(url: str) -> str:
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError(f"Not an http(s) URL: {url}")
    if parts.username or parts.password:
        raise FetchError("URLs with embedded credentials are not allowed.")
    host = parts.hostname.lower().rstrip(".")
    netloc = host if parts.port in (None, 80, 443) else f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))


def check_public(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError(f"Cannot resolve {host}: {exc}") from exc
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise FetchError(f"{host} resolves to a non-public address; refusing to connect.")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Fetcher:
    def __init__(self, allowed_hosts, user_agent: str, delay: float, max_bytes: int,
                 check_address=check_public):
        self.allowed = {h.lower().rstrip(".") for h in allowed_hosts}
        self.user_agent = user_agent
        self.delay = delay
        self.max_bytes = max_bytes
        self.check_address = check_address
        self._opener = urllib.request.build_opener(_NoRedirect)
        self._robots: dict[str, RobotFileParser] = {}
        self._last: dict[str, float] = {}

    # -- low level ---------------------------------------------------------------

    def _request(self, url: str, headers: dict | None = None, limit: int | None = None) -> Response:
        host = urlsplit(url).hostname
        if host not in self.allowed:
            raise FetchError(f"{host} is not in this source's allowed hosts.")
        self.check_address(host)
        wait = self.delay - (time.monotonic() - self._last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        self._last[host] = time.monotonic()
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent, **(headers or {})})
        limit = limit or self.max_bytes
        try:
            with self._opener.open(request, timeout=30) as resp:
                length = int(resp.headers.get("Content-Length") or 0)
                if length > limit:
                    raise FetchError(f"File is larger than the {limit // 1048576} MB limit.")
                body = resp.read(limit + 1)
                if len(body) > limit:
                    raise FetchError(f"File is larger than the {limit // 1048576} MB limit.")
                return Response(url, resp.status, {k.lower(): v for k, v in resp.headers.items()}, body)
        except urllib.error.HTTPError as err:
            return Response(url, err.code, {k.lower(): v for k, v in (err.headers or {}).items()}, b"")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            raise FetchError(f"Could not reach {host}: {err}") from err

    def _allowed_by_robots(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            parser = RobotFileParser()
            resp = self._request(origin + "/robots.txt", limit=1_000_000)
            if resp.status == 200:
                parser.parse(resp.body.decode("utf-8", errors="replace").splitlines())
            else:
                parser.parse([])  # no robots.txt (or unreadable): nothing disallowed
            self._robots[origin] = parser
        return self._robots[origin].can_fetch(self.user_agent, url)

    # -- public ------------------------------------------------------------------

    def get(self, url: str, headers: dict | None = None) -> Response:
        url = canonical_url(url)
        for _ in range(MAX_REDIRECTS + 1):
            if not self._allowed_by_robots(url):
                raise FetchError(f"robots.txt does not allow {url}")
            resp = self._request(url, headers)
            if resp.status in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                url = canonical_url(urljoin(url, resp.headers["location"]))
                continue
            return resp
        raise FetchError("Too many redirects.")


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str, bool]] = []
        self._href = None
        self._download = False
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            attrs = dict(attrs)
            self._href = attrs.get("href")
            self._download = "download" in attrs
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href:
            self.links.append((self._href, " ".join("".join(self._text).split()), self._download))
            self._href = None


def datasheet_links(html: bytes, base_url: str, allowed_hosts, patterns: list[str]) -> list[str]:
    """PDF links on a product page that match the source's link patterns."""
    parser = _LinkParser()
    parser.feed(html.decode("utf-8", errors="replace"))
    found: list[str] = []
    for href, label, is_download in parser.links:
        try:
            link = canonical_url(urljoin(base_url, href))
        except FetchError:
            continue
        if urlsplit(link).hostname not in allowed_hosts:
            continue
        looks_like_file = urlsplit(link).path.lower().endswith(".pdf") or is_download
        haystack = f"{unquote(link)} {label}".lower()
        if looks_like_file and (not patterns or any(p in haystack for p in patterns)):
            if link not in found:
                found.append(link)
    return found


def filename_for(url: str, headers: dict) -> str:
    disposition = headers.get("content-disposition", "")
    match = re.search(r"filename\*?=(?:UTF-8'')?[\"']?([^\";\r\n]+)", disposition, re.I)
    if match:
        return unquote(match.group(1).strip())
    return unquote(PurePosixPath(urlsplit(url).path).name) or "datasheet.pdf"
