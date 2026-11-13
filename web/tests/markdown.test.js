import { test, expect, describe, beforeAll } from "bun:test";
import { JSDOM } from "jsdom";

let renderMarkdown, renderDescription, sanitizeHtml;

beforeAll(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.DOMParser = dom.window.DOMParser;
  ({ renderMarkdown, renderDescription, sanitizeHtml } = await import("../src/lib/markdown.js"));
});

const MODRINTH_DESCRIPTION = `# Structory: Towers

[![Latest Version](https://img.shields.io/github/v/release/Stardust-Labs-MC/Structory-Towers?color=blueviolet&logo=github "View latest release")](https://github.com/Stardust-Labs-MC/Structory-Towers/releases)

Structory: Towers adds immersive, biome-themed towers to the world, such as outposts, firetowers, ocean monument pillars, Nether and End towers; and more.

![Structory: Towers Banner](https://user-images.githubusercontent.com/63272345/224815788-04bd6bd7-b1b0-42c2-aa7b-1be0ba6195a2.png)

## Notes
- Structory: Towers is compatible with the majority of worldgen and structure datapacks, such as Terralith or Structory
- You can add Structory: Towers to existing worlds, but structures will only generate in new chunks
- This is compatible with Waystones

## Description
### Seasons
Alongside regular updates, [Structory](https://github.com/Stardust-Labs-MC/Structory) consistently receives themed content expansions.

Season 1 brought the Ruins update. Deep inside the swamps, the **Mangrove Ruins** can be found... but if you dare venture into a colder climate, you may stumble upon the **Taiga Ruins**.

<center>
  <img src="https://user-images.githubusercontent.com/63272345/224786738-7baefaf8-267f-41b6-8ac5-53cc4bd5707e.png" alt="Patron Ad">
</center>

\`\`\`java
String hello = "world";
\`\`\`

| Loader | Version |
|---|---|
| Fabric | 1.20.1 |
`;

describe("markdown renderer", () => {
  test("renders Modrinth markdown structure", () => {
    const html = renderMarkdown(MODRINTH_DESCRIPTION);
    expect(html).toContain("<h1>Structory: Towers</h1>");
    expect(html).toContain("<h2>Notes</h2>");
    expect(html).toContain("<h3>Seasons</h3>");
    expect(html).toContain("<strong>Mangrove Ruins</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Loader</th>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("String hello");
  });

  test("renders images and links safely", () => {
    const html = renderMarkdown(MODRINTH_DESCRIPTION);
    expect(html).toContain('<img src="https://img.shields.io/github/v/release/');
    expect(html).toContain('<a href="https://github.com/Stardust-Labs-MC/Structory"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
  });

  test("keeps safe inline HTML blocks", () => {
    const html = renderMarkdown('<center>\n  <img src="https://example.com/a.png" alt="Ad">\n</center>');
    expect(html).toContain("<center>");
    expect(html).toContain('<img src="https://example.com/a.png"');
  });

  test("sanitizes HTML descriptions per platform", () => {
    const html = renderDescription({
      description_format: "html",
      body: '<p onclick="alert(1)">Hello <strong>world</strong></p><script>alert(1)</script><img src="javascript:alert(1)">',
    });
    expect(html).toContain("<strong>world</strong>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
  });

  test("escapes plain-text descriptions", () => {
    const html = renderDescription({
      description_format: "text",
      body: "Line one\nLine two <script>alert(1)</script>",
    });
    expect(html).toContain("Line one<br>");
    expect(html).not.toContain("<script>");
  });

  test("sanitizes markdown output", () => {
    const html = sanitizeHtml('<p>ok</p><script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(1)">');
    expect(html).toContain("<p>ok</p>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
    expect(html).toContain('<img src="https://x.test/a.png"');
  });

  test("renders table column alignment", () => {
    const html = renderMarkdown("| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |");
    expect(html).toContain('<th style="text-align: left">Left</th>');
    expect(html).toContain('<th style="text-align: center">Center</th>');
    expect(html).toContain('<th style="text-align: right">Right</th>');
    expect(html).toContain('<td style="text-align: right">c</td>');
  });

  test("renders Modrinth newline rules", () => {
    expect(renderMarkdown("This will all\ngo on one line.")).toBe("<p>This will all go on one line.</p>");
    expect(renderMarkdown("This will be\\\nsplit into two lines")).toBe("<p>This will be<br>split into two lines</p>");
    expect(renderMarkdown("This will also be  \nsplit into two lines")).toBe("<p>This will also be<br>split into two lines</p>");
  });

  test("renders nested lists", () => {
    const html = renderMarkdown("- first\n  - nested\n- second");
    expect(html).toContain("<li>first<ul><li>nested</li></ul></li>");
    expect(html).toContain("<li>second</li>");
  });

  test("renders markdown inside details spoilers", () => {
    const html = renderMarkdown("<details>\n<summary>Spoiler</summary>\n\n**hidden**\n\n</details>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Spoiler</summary>");
    expect(html).toContain("<strong>hidden</strong>");
  });

  test("renders task list checkboxes", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('<input type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("done");
    expect(html).toContain("todo");
  });

  test("allows only YouTube and Discord iframes", () => {
    const html = renderMarkdown('<iframe src="https://www.youtube.com/embed/abc"></iframe><iframe src="https://evil.test/embed/abc"></iframe>');
    expect(html).toContain("youtube.com/embed/abc");
    expect(html).not.toContain("evil.test");
  });

  test("keeps only supported inline styles", () => {
    const html = renderMarkdown('<span style="text-align: center; color: red">x</span>');
    expect(html).toContain('style="text-align: center"');
    expect(html).not.toContain("color");
  });
});