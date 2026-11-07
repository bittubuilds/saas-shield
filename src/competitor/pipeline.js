'use strict';
// Evaluate one discovered candidate and persist what we actually observed.
//
// Failure policy: a candidate we cannot fetch is stored as 'unverifiable' with
// the fetch error. It is never dropped silently, and no field is filled in from
// the search result alone, because a search snippet is not evidence of what the
// site is.

const crawler = require('../crawler');
const { classifyPage } = require('./classify');
const { identifyProduct } = require('./identify');
const { scoreRelevance, verdictReason } = require('./score');
const store = require('./store');

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readPage(html, url) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1]
    || (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) || [])[1]
    || '';
  const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  return {
    url,
    title: stripHtml(title),
    ogTitle: stripHtml(ogTitle),
    description: stripHtml(desc),
    h1: stripHtml(h1),
    text: stripHtml(html).slice(0, 20000)
  };
}

// How much of the original's own vocabulary a candidate must share before its
// category, audience and positioning are treated as comparable signals. Absent
// content on either side simply means those components score zero.
async function evaluateCandidate({
  workspaceId, discoveryId = null, websiteId = null, url, searchRank = null,
  query = null, original, createdBy = null, fetchPage = crawler.fetchPage
}) {
  let domain;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return { decision: 'rejected', reason: 'invalid url' };
  }

  const classification = classifyPage(url);
  let page = null;
  let httpStatus = null;
  let fetchError = null;

  try {
    const res = await fetchPage(url);
    httpStatus = res && (res.status || res.statusCode) || null;
    const html = (res && (res.html || res.body)) || '';
    if (httpStatus && httpStatus >= 400) {
      fetchError = `HTTP ${httpStatus}`;
    } else if (!html) {
      fetchError = 'empty response';
    } else {
      page = readPage(html, url);
    }
  } catch (e) {
    fetchError = e.message || 'fetch failed';
  }

  // Unreachable candidate: keep the record, claim nothing.
  if (!page) {
    const { id } = store.upsertCompetitor({
      workspaceId, discoveryId, websiteId, domain, siteUrl: url,
      status: 'unverifiable', statusReason: fetchError || 'page could not be fetched',
      sourceUrl: url, discoverySource: 'auto-discovery', createdBy
    });
    store.recordPage({
      workspaceId, competitorId: id, url, pageType: classification.page_type,
      confidence: classification.confidence, classificationReason: classification.reason,
      httpStatus, fetchStatus: 'failed', fetchError
    });
    store.recordDiscovery({
      workspaceId, discoveryId, competitorId: id, query, resultUrl: url, resultHost: domain,
      searchRank, decision: 'rejected', reason: `not evaluated: ${fetchError || 'fetch failed'}`
    });
    return { competitorId: id, decision: 'unverifiable', reason: fetchError, domain };
  }

  const identified = identifyProduct(page, { domain });
  const scored = original ? scoreRelevance(identified, original, { searchRank }) : null;
  const decision = scored ? scored.verdict : 'possible';
  const reason = scored ? verdictReason(scored) : 'no original product profile to compare against';

  const { id } = store.upsertCompetitor({
    workspaceId, discoveryId, websiteId, domain, siteUrl: url,
    name: identified.name, description: identified.description,
    category: identified.category, targetAudience: identified.targetAudience,
    positioning: identified.positioning,
    relevanceScore: scored ? scored.score : null,
    breakdown: scored ? scored.components : null,
    status: decision, statusReason: reason,
    sourceUrl: url, discoverySource: 'auto-discovery', createdBy
  });

  const pageId = store.recordPage({
    workspaceId, competitorId: id, url,
    pageType: classification.page_type, confidence: classification.confidence,
    classificationReason: classification.reason, httpStatus,
    fetchStatus: 'ok'
  });

  // Evidence for each field we actually read, with its source.
  const fields = [
    ['name', identified.name, 'page_title', identified.title ? 0.7 : null],
    ['description', identified.description, 'meta_description', identified.description ? 0.6 : null],
    ['category', identified.category, 'category_keywords', identified.categoryConfidence],
    ['target_audience', identified.targetAudience, 'audience_phrase', identified.audienceConfidence],
    ['positioning', identified.positioning, 'h1_heading', identified.positioning ? 0.6 : null]
  ];
  for (const [field, value, type, confidence] of fields) {
    if (!value) continue;
    store.recordEvidence({
      workspaceId, competitorId: id, pageId, sourceUrl: url, evidenceType: type,
      field, excerpt: value, confidence,
      verificationStatus: field === 'category' || field === 'target_audience' ? 'inferred' : 'observed'
    });
  }

  store.recordDiscovery({
    workspaceId, discoveryId, competitorId: id, query, resultUrl: url, resultHost: domain,
    searchRank, decision, score: scored ? scored.score : null,
    breakdown: scored ? scored.components : null, reason
  });

  return { competitorId: id, decision, score: scored ? scored.score : null, domain };
}

// Build the comparison profile for the user's own site from its crawled pages.
function profileFromPages(pages = []) {
  const usable = pages.filter((p) => p && (p.text_content || p.title));
  if (usable.length === 0) return null;
  const primary = usable[0];
  const combinedText = usable.map((p) => p.text_content || '').join(' ').slice(0, 20000);
  return identifyProduct({
    title: primary.title || '',
    description: primary.meta_description || '',
    h1: primary.h1 || '',
    text: combinedText
  }, { domain: primary.normalized_domain || null });
}

module.exports = { evaluateCandidate, profileFromPages, readPage, stripHtml };
