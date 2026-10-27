import { createRoot } from "react-dom/client";
import { App } from "./main.js";

// Rendering lives apart from App so React Fast Refresh can treat main.tsx as a
// component module. Otherwise any change reaching it, such as a card merged into
// Bakery's own checkout, reloads the whole page and closes the open card.
createRoot(document.getElementById("root")!).render(<App />);
