import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRetryGitHubPublication,
  getGitHubPublicationPresentation,
  getGitHubPublicationUrl,
} from './githubPublication.js';

test('publication presentation separates published and failed states from analysis status', () => {
  assert.equal(getGitHubPublicationPresentation('published').label, 'Published');
  assert.equal(getGitHubPublicationPresentation('failed').label, 'Failed');
  assert.match(getGitHubPublicationPresentation('failed').description, /Analysis and findings are saved/);
  assert.equal(getGitHubPublicationPresentation('not_needed').label, 'Not applicable');
  assert.equal(getGitHubPublicationPresentation(undefined).label, 'Not recorded');
  assert.equal(getGitHubPublicationPresentation('pending', 'failed').label, 'Not attempted');
});

test('publication retry is available only for completed reviews with a definite publication failure', () => {
  assert.equal(canRetryGitHubPublication({ status: 'completed', githubPublicationStatus: 'failed' }), true);
  assert.equal(canRetryGitHubPublication({ status: 'failed', githubPublicationStatus: 'failed' }), false);
  assert.equal(canRetryGitHubPublication({ status: 'completed', githubPublicationStatus: 'uncertain' }), false);
});

test('only HTTPS GitHub publication URLs are linkable', () => {
  assert.equal(getGitHubPublicationUrl('https://github.com/owner/repo/pull/1'), 'https://github.com/owner/repo/pull/1');
  assert.equal(getGitHubPublicationUrl('http://github.com/owner/repo/pull/1'), null);
  assert.equal(getGitHubPublicationUrl('https://evil.example/review'), null);
});
