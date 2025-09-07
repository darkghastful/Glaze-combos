// CommonJS with dynamic import for ESM Octokit

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');

initializeApp();
setGlobalOptions({ region: 'us-central1' }); // ensure you only call this once in your codebase

// Secrets set via: firebase functions:secrets:set GH_TOKEN / GH_OWNER / GH_REPO
const GH_TOKEN = defineSecret('GH_TOKEN');
const GH_OWNER = defineSecret('GH_OWNER');
const GH_REPO  = defineSecret('GH_REPO');

// change if you prefer "sugessions"
const SUGGEST_LABEL = 'suggestions';

exports.submitSuggestion = onCall({ secrets: [GH_TOKEN, GH_OWNER, GH_REPO] }, async (request) => {
  // ESM-only import inside CJS:
  const { Octokit } = await import('@octokit/rest');

  const data = request.data || {};
  const text = (data.text || '').toString().trim();
  if (!text) throw new Error('Missing suggestion text');

  const meta = [];
  if (data.identifier) meta.push(`Identifier: ${data.identifier}`);
  if (data.clay_body)  meta.push(`Clay body: ${data.clay_body}`);
  if (Array.isArray(data.glazes) && data.glazes.length) meta.push(`Glazes: ${data.glazes.join(', ')}`);
  if (data.page)       meta.push(`Page: ${data.page}`);

  const body =
`**New suggestion**
${meta.map(s => `- ${s}`).join('\n')}

> ${text}
`;

  const owner = GH_OWNER.value();
  const repo  = GH_REPO.value();
  const octokit = new Octokit({ auth: GH_TOKEN.value() });

  // Ensure the label exists
  try {
    await octokit.issues.getLabel({ owner, repo, name: SUGGEST_LABEL });
  } catch (e) {
    if (e.status === 404) {
      await octokit.issues.createLabel({
        owner, repo,
        name: SUGGEST_LABEL,
        color: 'ededed',
        description: 'Community suggestions'
      });
    } else {
      throw e;
    }
  }

  // Find or create the collector issue
  const { data: issues } = await octokit.issues.listForRepo({
    owner, repo, state: 'open', labels: SUGGEST_LABEL, per_page: 100
  });
  let issueNumber = issues[0]?.number;
  if (!issueNumber) {
    const created = await octokit.issues.create({
      owner, repo,
      title: 'Community suggestions',
      labels: [SUGGEST_LABEL],
      body: 'This issue collects suggestions from the site. Each new suggestion is added as a comment below.'
    });
    issueNumber = created.data.number;
  }

  // Add the comment
  await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });

  return { ok: true, issue_number: issueNumber };
});
