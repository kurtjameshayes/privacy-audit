import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const rootElement = document.getElementById("app");

if (rootElement) {
  // #region agent log
  fetch("http://127.0.0.1:7513/ingest/ca35bdd0-a85e-4f3f-8fa2-3df702c131ad",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"547d10"},body:JSON.stringify({sessionId:"547d10",runId:"pre-fix-1",hypothesisId:"H1",location:"frontend/src/main.tsx:10",message:"pre-render root and stylesheet links",data:{rootFound:Boolean(rootElement),stylesheets:Array.from(document.querySelectorAll('link[rel=\"stylesheet\"]')).map((l)=>l.getAttribute("href")),scripts:Array.from(document.querySelectorAll('script[type=\"module\"]')).map((s)=>s.getAttribute("src"))},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  // #region agent log
  fetch("http://127.0.0.1:7513/ingest/ca35bdd0-a85e-4f3f-8fa2-3df702c131ad",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"547d10"},body:JSON.stringify({sessionId:"547d10",runId:"pre-fix-1",hypothesisId:"H2",location:"frontend/src/main.tsx:16",message:"post-render root child count",data:{rootChildCount:rootElement.childElementCount,rootTextSample:(rootElement.textContent||"").slice(0,120),styleSheetCount:document.styleSheets.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}
