# Pottery Gallery (GitHub Pages)

Static gallery with filter + detail modal. Submissions via GitHub Issues; a GitHub Action ingests them and updates `data/items.json`.

## Quick start
1. Create a new repo and upload these files (or unzip and push).
2. In `index.html`, replace `YOUR_USER/YOUR_REPO` with your repo path.
3. Enable GitHub Pages for the repo.
4. Open a new issue using the **Pottery submission** template and attach an image.
5. The workflow downloads the image, appends data to `data/items.json`, commits, and closes the issue.

> Submit button URL (after you set your org/repo):  
> `https://github.com/YOUR_USER/YOUR_REPO/issues/new?template=pottery-submission.yml`

## Data schema
```json
{
  "id": "uuid",
  "identifier": "BQ-001",
  "glaze": "Shino",
  "clay_body": "Stoneware",
  "notes": "Warm orange peel effect.",
  "tags": ["cup"],
  "image_url": "images/example-1.jpg",
  "submitted_at": "2025-08-15T18:30:00Z",
  "source_issue": 1
}
```
