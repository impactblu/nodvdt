"""PCS Atlas collector.

Checks supplier websites for datasheet changes, archives every datasheet
revision, re-checks the published specifications against new revisions,
and pushes the updated data to the GitHub repository that hosts the site.

Only the Python standard library is used. External tools: git and
pdftotext (poppler-utils).
"""

__version__ = "2.0.0"
