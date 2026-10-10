import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "../../client/src/client";
import { ClientProvider, useClient, useShellCapabilities } from "../src/client-context";

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});

function Probe() {
  const injected = useClient();
  const shell = useShellCapabilities();
  return <span>{injected === client ? "client" : "wrong"}:{shell?.hideWindow ? "hide" : "web"}:{shell?.quit ? "quit" : "no-quit"}</span>;
}

it("supports web without a shell and a partial desktop capability object", () => {
  expect(renderToStaticMarkup(<ClientProvider client={client}><Probe /></ClientProvider>))
    .toBe("<span>client:web:no-quit</span>");
  expect(renderToStaticMarkup(<ClientProvider client={client} shell={{ hideWindow: async () => {} }}><Probe /></ClientProvider>))
    .toBe("<span>client:hide:no-quit</span>");
});
