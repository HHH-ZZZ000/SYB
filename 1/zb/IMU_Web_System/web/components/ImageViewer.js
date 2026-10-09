import { element } from "../lib/format.js";

// Native dialog keeps focus inside the viewer and restores it on close.
export function ImageViewer() {
  const root = element('<dialog class="image-viewer" aria-label="环境图片大图"><button type="button" class="image-viewer-close" autofocus aria-label="关闭大图">关闭 ×</button><img alt=""><p class="image-viewer-caption"></p></dialog>');
  const image = root.querySelector("img"), caption = root.querySelector("p");
  const close = () => root.close();
  root.querySelector("button").addEventListener("click", close);
  root.addEventListener("click", event => { if (event.target === root) close(); });
  image.addEventListener("error", () => { image.hidden = true; caption.textContent = "图片不可用或已到保留期限。"; });
  document.body.append(root);
  return {
    open(source, description) {
      image.hidden = false;
      image.src = source;
      image.alt = description;
      caption.textContent = description;
      root.showModal();
    },
    destroy() { if (root.open) close(); root.remove(); },
  };
}
