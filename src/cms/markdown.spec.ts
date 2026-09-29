import {
  excerptFrom,
  fillVariables,
  markdownToText,
  renderMarkdown,
  variablesUsed,
} from './markdown';

/**
 * The escaping tests are the important ones.
 *
 * This content is written by an admin and rendered on the public website, in
 * the apps and inside emails. If any of it can introduce a tag the renderer did
 * not write, the CMS is a stored-XSS hole on the marketing site.
 */
describe('renderMarkdown — safety', () => {
  it('renders a script tag as text, never as a tag', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises an inline event handler', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img');
  });

  it('refuses a javascript: link', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
    // The label survives, so the sentence still reads.
    expect(html).toContain('click me');
  });

  it('refuses a data: URL, which can carry a whole document', () => {
    expect(renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')).toContain('href="#"');
  });

  it('refuses vbscript:', () => {
    expect(renderMarkdown('[x](vbscript:msgbox)')).toContain('href="#"');
  });

  it('allows http, https, mailto, tel and site-relative links', () => {
    for (const url of [
      'https://davochain.com',
      'http://davochain.com',
      'mailto:support@davochain.com',
      'tel:+2349160012046',
      '/terms-and-conditions',
    ]) {
      expect(renderMarkdown(`[x](${url})`)).toContain(`href="${url}"`);
    }
  });

  it('escapes quotes so a link cannot break out of its attribute', () => {
    const html = renderMarkdown('[x](https://a.com" onmouseover="alert(1))');
    expect(html).not.toContain('onmouseover="alert(1)"');
  });

  it('escapes a value substituted into the body', () => {
    // A user whose name contains markup must not be able to inject through an
    // email that greets them by it.
    const filled = fillVariables('Hi {{firstName}},', { firstName: '<script>alert(1)</script>' });
    const html = renderMarkdown(filled);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderMarkdown — formatting', () => {
  it('renders headings at the right level', () => {
    expect(renderMarkdown('# One')).toBe('<h1>One</h1>');
    expect(renderMarkdown('### Three')).toBe('<h3>Three</h3>');
  });

  it('renders bold and italic without confusing the two', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
    expect(renderMarkdown('**bold** and *italic*')).toBe(
      '<p><strong>bold</strong> and <em>italic</em></p>',
    );
  });

  it('does not read emphasis inside code', () => {
    expect(renderMarkdown('`a *b* c`')).toContain('<code>a *b* c</code>');
  });

  it('joins a wrapped paragraph into one', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one two</p>');
  });

  it('separates paragraphs on a blank line', () => {
    expect(renderMarkdown('one\n\ntwo')).toBe('<p>one</p>\n<p>two</p>');
  });

  it('renders a wrapped quote as ONE blockquote', () => {
    // Rendering a blockquote per line boxes each line separately, which reads
    // as a mistake.
    const html = renderMarkdown('> first line\n> second line');
    expect(html).toBe('<blockquote>first line second line</blockquote>');
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
  });

  it('closes a quote when ordinary text follows it', () => {
    expect(renderMarkdown('> quoted\n\nafter')).toBe(
      '<blockquote>quoted</blockquote>\n<p>after</p>',
    );
  });

  it('renders bullet and numbered lists, and closes them', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
  });

  it('switches list type without nesting one inside the other', () => {
    const html = renderMarkdown('- a\n1. b');
    expect(html).toBe('<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>');
  });

  it('renders a horizontal rule', () => {
    expect(renderMarkdown('---')).toBe('<hr />');
  });

  it('handles an empty body', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('markdownToText', () => {
  it('strips formatting and keeps the words', () => {
    expect(markdownToText('## Title\n\n**bold** and *italic*')).toBe('Title\n\nbold and italic');
  });

  it('keeps a link readable by showing its target', () => {
    expect(markdownToText('[terms](https://davochain.com/terms)')).toBe(
      'terms (https://davochain.com/terms)',
    );
  });
});

describe('fillVariables', () => {
  it('substitutes a known value', () => {
    expect(fillVariables('Hi {{firstName}}', { firstName: 'Ada' })).toBe('Hi Ada');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(fillVariables('Hi {{ firstName }}', { firstName: 'Ada' })).toBe('Hi Ada');
  });

  it('leaves an unknown placeholder standing rather than blanking it', () => {
    // "Hi ," in a live email is a bug that reads as one; a visible {{typo}}
    // says exactly what went wrong.
    expect(fillVariables('Hi {{typo}}', { firstName: 'Ada' })).toBe('Hi {{typo}}');
  });

  it('treats null, undefined and empty string as unset', () => {
    expect(fillVariables('X{{a}}', { a: null })).toBe('X{{a}}');
    expect(fillVariables('X{{a}}', { a: undefined })).toBe('X{{a}}');
    expect(fillVariables('X{{a}}', { a: '' })).toBe('X{{a}}');
  });
});

describe('variablesUsed', () => {
  it('lists each placeholder once', () => {
    expect(variablesUsed('{{a}} {{b}} {{a}}').sort()).toEqual(['a', 'b']);
  });
});

describe('excerptFrom', () => {
  it('returns short text unchanged', () => {
    expect(excerptFrom('## Hello\n\nShort body.')).toBe('Hello Short body.');
  });

  it('truncates on a word boundary', () => {
    const excerpt = excerptFrom('word '.repeat(100));
    expect(excerpt.length).toBeLessThanOrEqual(181);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});
