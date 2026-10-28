import { expect, test } from "bun:test";
import { apiDocsTool } from "../api-tools";

test("the docs tool finds presentations.batchUpdate and forms.batchUpdate", async () => {
  const documents: Record<string, unknown> = {
    slides: {
      servicePath: "",
      resources: {
        presentations: {
          methods: {
            batchUpdate: {
              id: "slides.presentations.batchUpdate",
              httpMethod: "POST",
              path: "v1/presentations/{presentationId}:batchUpdate",
            },
          },
        },
      },
    },
    forms: {
      servicePath: "",
      resources: {
        forms: {
          methods: {
            batchUpdate: {
              id: "forms.forms.batchUpdate",
              httpMethod: "POST",
              path: "v1/forms/{formId}:batchUpdate",
            },
          },
        },
      },
    },
  };
  const fetched: string[] = [];
  const tool = apiDocsTool(async (url) => {
    fetched.push(url);
    return Response.json(documents[url.includes("slides") ? "slides" : "forms"]);
  });
  const ctx = {
    session: "s",
    pick: async () => null,
    signal: new AbortController().signal,
    scratchpad: "/",
  };
  expect(await tool.call({ api: "slides", query: "batchUpdate" }, ctx)).toContain(
    "slides.presentations.batchUpdate  POST /v1/presentations/{presentationId}:batchUpdate",
  );
  expect(await tool.call({ api: "forms", query: "batchUpdate" }, ctx)).toContain(
    "forms.forms.batchUpdate  POST /v1/forms/{formId}:batchUpdate",
  );
  expect(fetched).toEqual([
    "https://slides.googleapis.com/$discovery/rest?version=v1",
    "https://forms.googleapis.com/$discovery/rest?version=v1",
  ]);
});
