import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaFormatForUrl, extOf } from '../share-routing.mjs';

test('audio URLs resolve to "audio"', () => {
  assert.equal(mediaFormatForUrl('https://x.com/a/song.mp3'), 'audio');
  assert.equal(mediaFormatForUrl('https://x.com/a/song.m4a'), 'audio');
  assert.equal(mediaFormatForUrl('https://x.com/a/song.ogg'), 'audio');
  assert.equal(mediaFormatForUrl('https://x.com/a/song.wav'), 'audio');
});

test('video URLs resolve to "video"', () => {
  assert.equal(mediaFormatForUrl('https://x.com/clip.mp4'), 'video');
  assert.equal(mediaFormatForUrl('https://x.com/clip.webm'), 'video');
  assert.equal(mediaFormatForUrl('https://x.com/clip.mov'), 'video');
});

test('query/hash on a media URL is ignored', () => {
  assert.equal(mediaFormatForUrl('https://x.com/v.mp4?t=10#x'), 'video');
  assert.equal(mediaFormatForUrl('https://x.com/a.mp3?dl=1'), 'audio');
});

test('non-media web pages resolve to null', () => {
  assert.equal(mediaFormatForUrl('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(mediaFormatForUrl('https://open.spotify.com/episode/abc'), null);
  assert.equal(mediaFormatForUrl('https://example.com/post/hello'), null);
});

test('invalid / non-absolute inputs resolve to null', () => {
  assert.equal(mediaFormatForUrl('not a url'), null);
  assert.equal(mediaFormatForUrl('/local/file.mp3'), null);
});

test('extOf extracts the trailing extension, lowercased', () => {
  assert.equal(extOf('song.MP3'), 'mp3');
  assert.equal(extOf('/a/b/clip.mp4?x=1#y'), 'mp4');
  assert.equal(extOf('noextension'), '');
});
