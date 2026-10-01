import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sameRenderer } from '../src/main/trusted-url';

describe('IPC sender check', () => {
  it('accepts the packaged renderer as Chromium reports it (file:///C:/...)', () => {
    const expected =
      'file:///C:/Users/a/AppData/Local/Programs/EventKit/resources/app.asar/out/renderer/index.html';
    expect(sameRenderer(`${expected}#/setup`, expected, true)).toBe(true);
    expect(sameRenderer(expected.replace('/Users/a/', '/users/A/'), expected, true)).toBe(true);
    expect(sameRenderer(expected.replace('EventKit', 'Event%4Bit'), expected, true)).toBe(true);
  });

  it('matches pathToFileURL output on this OS', () => {
    const url = pathToFileURL(`${process.cwd()}/out/renderer/index.html`).href;
    expect(sameRenderer(url, url)).toBe(true);
  });

  it('rejects other files, hosts and origins', () => {
    const expected = 'file:///opt/EventKit/resources/app.asar/out/renderer/index.html';
    expect(sameRenderer('file:///tmp/evil/index.html', expected)).toBe(false);
    expect(
      sameRenderer(
        'file://evil-host/opt/EventKit/resources/app.asar/out/renderer/index.html',
        expected,
      ),
    ).toBe(false);
    expect(sameRenderer(expected.toUpperCase().replace('FILE:', 'file:'), expected, false)).toBe(
      false,
    );
    expect(sameRenderer('https://example.org/', expected)).toBe(false);
    expect(sameRenderer('not a url', expected)).toBe(false);
    expect(sameRenderer('http://localhost:5173/#/x', 'http://localhost:5173/')).toBe(true);
    expect(sameRenderer('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
  });
});
