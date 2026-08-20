import { createRoot } from "react-dom/client";
import tabIconUrl from "@assets/83535181-5ECF-490F-907C-76B6905E9E29_1786829563526_crop_1787200220897.png";
import App from "./App";
import "./index.css";

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');

if (favicon) {
  favicon.href = tabIconUrl;
  favicon.type = "image/png";
}

createRoot(document.getElementById("root")!).render(<App />);
