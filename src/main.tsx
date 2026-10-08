import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Cada deploy apaga os pedaços antigos do app. Uma aba aberta desde antes, ao abrir
// uma tela que ainda não tinha baixado, pede um arquivo que não existe mais: recarrega
// uma vez (no máximo uma por minuto, para um pedaço quebrado não virar laço).
window.addEventListener("vite:preloadError", (e) => {
  try {
    const ultima = Number(sessionStorage.getItem("saasmail.recarregou") ?? 0);
    if (Date.now() - ultima < 60_000) return;
    sessionStorage.setItem("saasmail.recarregou", String(Date.now()));
  } catch {
    return;
  }
  e.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
