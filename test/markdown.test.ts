import { expect, test } from "bun:test";
import type { DriveComment } from "../drive";
import { capText, extractPictures, MAX_PICTURES, renderComments, TEXT_CAP } from "../markdown";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("inline and reference-style pictures become [picture N] and are listed in order", () => {
  const markdown = `Intro ![a](${PNG}) and ![][image1].\n\n[image1]: <data:image/jpeg;base64,/9j/4AAQ=>\n`;
  const { text, pictures } = extractPictures(markdown);
  expect(text).toBe("Intro [picture 1] and [picture 2].");
  expect(pictures).toEqual([
    { mediaType: "image/png", data: "iVBORw0KGgo=" },
    { mediaType: "image/jpeg", data: "/9j/4AAQ=" },
  ]);
});

test("data URIs that are not png, jpeg, gif or webp stay where they are", () => {
  const svg = "![x](data:image/svg+xml;base64,PHN2Zz4=)";
  const pdf = "[doc]: <data:application/pdf;base64,JVBERg==>";
  const { text, pictures } = extractPictures(`${svg}\n\n${pdf}\n`);
  expect(text).toBe(`${svg}\n\n${pdf}`);
  expect(pictures).toEqual([]);
});

test("only the first 20 pictures are returned; the rest say so", () => {
  const markdown = Array.from({ length: 22 }, () => `![](${PNG})`).join(" ");
  const { text, pictures } = extractPictures(markdown);
  expect(pictures).toHaveLength(MAX_PICTURES);
  expect(text).toContain("[picture 20]");
  expect(text).not.toContain("[picture 21]");
  expect(text.match(/\[more pictures not shown\]/g)).toHaveLength(2);
});

test("text under the cap is returned whole", () => {
  expect(capText("short", 0)).toBe("short");
});

test("text over the cap is cut at 60 000 characters and names the offset to read on", () => {
  const text = "x".repeat(TEXT_CAP + 500);
  const first = capText(text, 0);
  expect(first.startsWith("x".repeat(TEXT_CAP))).toBe(true);
  expect(first).toContain(`with offset ${TEXT_CAP} to read on`);
  expect(capText(text, TEXT_CAP)).toBe("x".repeat(500));
});

test("an offset past the end says how long the Doc is", () => {
  expect(capText("abc", 10)).toBe(
    "Offset 10 is past the end of the Doc, which is 3 characters long.",
  );
});

const comment = (over: Partial<DriveComment>): DriveComment => ({
  id: "c",
  content: "Fix this",
  resolved: false,
  createdTime: "2026-10-01T10:00:00.000Z",
  author: "Maryam",
  quoted: "the old text",
  replies: [],
  ...over,
});

test("open comments render quoted text, author, date and indented replies", () => {
  const out = renderComments([
    comment({
      replies: [{ content: "Done\nmostly", author: "Jimmy", createdTime: "2026-10-02T09:00:00Z" }],
    }),
  ]);
  expect(out).toBe(
    "> the old text\n\n**Maryam** · 2026-10-01: Fix this\n  ↳ **Jimmy** · 2026-10-02: Done\n    mostly",
  );
});

test("resolved comments are hidden unless asked for, and marked when shown", () => {
  const all = [comment({ id: "1" }), comment({ id: "2", resolved: true, content: "Old" })];
  expect(renderComments(all)).not.toContain("Old");
  expect(renderComments(all, true)).toContain("**Maryam** · 2026-10-01: Old (resolved)");
  expect(renderComments([])).toBe("");
});
