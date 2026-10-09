const paths = {
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  monitor: "M3 4h18v13H3zM8 21h8M12 17v4M6 11h3l2-4 3 7 2-3h2",
  realtime: "M3 12h4l3-8 4 16 3-8h4",
  history: "M3 12a9 9 0 1 0 3-6M3 3v5h5M12 7v5l3 2",
  assistant: "M4 4h16v12H9l-5 4V4zM8 8h8M8 12h5",
  camera: "M3 6h12v12H3zM15 10l6-4v12l-6-4",
  settings: "M5 3v18M12 3v18M19 3v18M2 8h6M9 16h6M16 8h6",
  chip: "M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
  arrow: "M5 12h14M14 7l5 5-5 5",
};
export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.monitor}"/></svg>`;
