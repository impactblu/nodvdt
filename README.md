# PCS Atlas website — impactblu/nodvdt

Copy the **contents of this `github-site` folder**, including `.github`, into the root of [impactblu/nodvdt](https://github.com/impactblu/nodvdt). The root must contain `site/index.html` and `.github/workflows/pages.yml`. The NAS application belongs in the separate `nas` folder of the delivery package and is not needed in this repository.

This deployment replaces the LT2 RFP Watcher at **https://nodvdt.com/**. Use the package's `DEPLOY_NODVDT.md` for the complete changeover sequence.

1. `site/config.js` is configured for **https://pcs-api.nodvdt.com**. This is the planned NAS API address; its DNS, HTTPS certificate, and proxy/tunnel still need configuration. The file contains no password.
2. In [repository Pages settings](https://github.com/impactblu/nodvdt/settings/pages), select **GitHub Actions** as the source. The workflow publishes only `site/` on pushes to `main` or when run manually. If your deployment branch has another name, update `branches` in the workflow. An existing competing Pages workflow needs to be retired during the changeover.
3. Set the custom domain to **nodvdt.com** in Pages settings before changing DNS. Follow `DEPLOY_NODVDT.md` to switch the root and `www` website records from Vercel to GitHub Pages, then enable HTTPS. No `/pcs/` path or Vercel rewrite is used.
4. The NAS `.env.example` already permits **https://nodvdt.com** and **https://www.nodvdt.com**. The setup script copies this into a new `.env`. If you already have `.env`, update `ALLOWED_ORIGINS` manually because setup preserves it. Recreate the services after an environment change.
5. Open **https://nodvdt.com/** and sign in with the account created by `nas/scripts/setup.sh`.

Before configuring the custom domain, the default Pages address is **https://impactblu.github.io/nodvdt/**. To test it against the NAS API, temporarily add `https://impactblu.github.io` to `ALLOWED_ORIGINS`. Remove it after testing if you will only use the custom domain.

All asset paths are relative and navigation uses hash routes, so the same files support a project URL under `/repository/` or a custom domain at `/`.

The website fetches search results, reviewed specs, uploads, original documents, exports, and history directly from the NAS API after sign-in. It does not publish the catalog or supplier files to GitHub. Collection updates become available when the relevant view is loaded or refreshed; they do not require a commit or site redeployment.

The sign-in credential is held only in the current page's memory. Refreshing or closing the page requires signing in again. There is no browser storage of credentials or cached catalog data. Authenticated document downloads are fetched as bytes first, so passwords never appear in file URLs. Your browser or password manager may separately offer to save your login.

The static website may be publicly reachable; the NAS API enforces authentication for catalog data. Do not put private information, passwords, source documents, database exports, or NAS `.env` files in `site/` or this repository.

The API must be reachable from the device using the website. If your NAS is available only through your LAN/VPN, connect that device to the LAN/VPN first. Use HTTPS with a trusted certificate. An HTTPS GitHub Pages site cannot fetch a plain HTTP NAS endpoint.

## References

- [GitHub Pages static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Pages custom-domain setup](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [HTTPS mixed-content restrictions](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
