import { excerptFromHtml, htmlToText, sanitiseHtml } from './sanitise';

/**
 * This is the security boundary for admin-authored content.
 *
 * Whatever survives here is rendered on the public website, inside the apps and
 * in email clients — all of which will execute what they are given. If a case
 * below starts passing something through, the CMS is a stored-XSS hole on the
 * marketing site.
 */
describe('sanitiseHtml — what must not survive', () => {
  it('drops a script element and its contents', () => {
    const out = sanitiseHtml('<p>Before</p><script>alert(1)</script><p>After</p>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
    // The prose either side is untouched.
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('drops a style element, which could restyle the whole page', () => {
    expect(sanitiseHtml('<style>body{display:none}</style><p>Hi</p>')).toBe('<p>Hi</p>');
  });

  it('drops an iframe', () => {
    expect(sanitiseHtml('<iframe src="https://evil.example"></iframe>')).not.toContain('iframe');
  });

  it('drops a form, which could ask for a password', () => {
    const out = sanitiseHtml('<form action="https://evil.example"><input name="pw"></form>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
  });

  it('strips every inline event handler', () => {
    for (const dirty of [
      '<img src="https://a.example/x.png" onerror="alert(1)">',
      '<p onclick="alert(1)">tap</p>',
      '<div onmouseover="alert(1)">hover</div>',
      '<a href="https://a.example" onfocus="alert(1)">link</a>',
    ]) {
      const out = sanitiseHtml(dirty);
      expect(out).not.toMatch(/on[a-z]+=/i);
      expect(out).not.toContain('alert');
    }
  });

  it('refuses javascript:, data: and vbscript: targets', () => {
    for (const scheme of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox']) {
      const out = sanitiseHtml(`<a href="${scheme}">tap</a>`);
      expect(out).not.toContain(scheme.split(':')[0] + ':');
      // The words survive even though the target does not.
      expect(out).toContain('tap');
    }
  });

  it('refuses a data: image, which would make an email megabytes', () => {
    const out = sanitiseHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">');
    expect(out).not.toContain('data:');
  });

  it('drops style properties outside the allowlist', () => {
    const out = sanitiseHtml('<p style="position:fixed;top:0;color:#c00">x</p>');
    expect(out).not.toContain('position');
    expect(out).not.toContain('top:');
    // The one that is legitimate stays.
    expect(out).toContain('color');
  });

  it('is not fooled by a protocol-relative URL', () => {
    expect(sanitiseHtml('<a href="//evil.example">x</a>')).not.toContain('//evil.example');
  });

  it('handles an empty or missing body without throwing', () => {
    expect(sanitiseHtml('')).toBe('');
    expect(sanitiseHtml(undefined as unknown as string)).toBe('');
  });
});

describe('sanitiseHtml — what the editor needs to keep', () => {
  it('keeps the formatting a body is made of', () => {
    const html =
      '<h2>Title</h2><p><strong>bold</strong> <em>italic</em> <u>under</u></p>' +
      '<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>quote</blockquote><hr />';
    const out = sanitiseHtml(html);
    for (const tag of ['h2', 'strong', 'em', 'u', 'ul', 'li', 'ol', 'blockquote', 'hr']) {
      expect(out).toContain(`<${tag}`);
    }
  });

  it('keeps a chosen font, size and colour', () => {
    const out = sanitiseHtml(
      '<p style="font-family:Georgia;font-size:18px;color:#1062d3;text-align:center">x</p>',
    );
    expect(out).toContain('font-family');
    expect(out).toContain('Georgia');
    expect(out).toContain('18px');
    expect(out).toContain('#1062d3');
    expect(out).toContain('center');
  });

  it('keeps tables, which a receipt-style email wants', () => {
    const out = sanitiseHtml('<table><tr><th colspan="2">h</th></tr><tr><td>a</td></tr></table>');
    expect(out).toContain('<table');
    expect(out).toContain('colspan="2"');
  });

  it('keeps http, https and mailto links', () => {
    for (const url of ['https://davochain.com', 'http://davochain.com', 'mailto:a@b.com']) {
      expect(sanitiseHtml(`<a href="${url}">x</a>`)).toContain(`href="${url}"`);
    }
  });

  it('adds rel=noopener to every outbound link', () => {
    const out = sanitiseHtml('<a href="https://davochain.com">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('keeps an https image', () => {
    expect(sanitiseHtml('<img src="https://a.example/x.png" alt="x">')).toContain('src=');
  });

  it('keeps the words when it removes an unknown tag', () => {
    // Losing the tag is correct; losing the sentence is not.
    expect(sanitiseHtml('<marquee>Important notice</marquee>')).toContain('Important notice');
  });
});

describe('htmlToText', () => {
  it('turns block boundaries into line breaks', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
  });

  it('keeps a link readable by showing its target', () => {
    expect(htmlToText('<a href="https://davochain.com/terms">terms</a>')).toBe(
      'terms (https://davochain.com/terms)',
    );
  });

  it('marks list items', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n\n- two');
  });

  it('decodes entities, so a text part reads as text', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &quot;quoted&quot;</p>')).toBe('Tom & Jerry "quoted"');
  });

  it('strips tags entirely', () => {
    expect(htmlToText('<p style="color:red">Hi <strong>there</strong></p>')).toBe('Hi there');
  });
});

describe('excerptFromHtml', () => {
  it('returns short text unchanged', () => {
    expect(excerptFromHtml('<h2>Hello</h2><p>Short body.</p>')).toBe('Hello Short body.');
  });

  it('truncates on a word boundary', () => {
    const excerpt = excerptFromHtml(`<p>${'word '.repeat(100)}</p>`);
    expect(excerpt.length).toBeLessThanOrEqual(181);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});
