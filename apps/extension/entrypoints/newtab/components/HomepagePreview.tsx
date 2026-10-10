import { SandpackLayout, SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";

const INDEX_JS = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);`;

const INDEX_HTML = `<!DOCTYPE html>
<html><head><title>My Personalized Homepage</title></head>
<body><div id="root"></div></body></html>`;

/**
 * Renders the agent's component in a Sandpack iframe. The code is
 * model-generated, so it runs sandboxed rather than in the extension's own page.
 */
export function HomepagePreview({ code }: { code: string }) {
  const files = {
    "/App.js": { code },
    "/index.js": { code: INDEX_JS },
    "/index.html": { code: INDEX_HTML },
  };

  return (
    <SandpackProvider files={files} template="react" options={{ autorun: true }} style={{ height: "100%", width: "100%" }}>
      <SandpackLayout style={{ height: "100%", width: "100%", border: "none", borderRadius: 0 }}>
        <SandpackPreview style={{ height: "100%" }} />
      </SandpackLayout>
    </SandpackProvider>
  );
}
