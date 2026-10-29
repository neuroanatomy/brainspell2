/** A brief swing of the scene that settles back to the initial view, so the brain visibly reads as 3D. */
export const spinHint = (scene, elem, duration = 2200, amplitude = Math.PI / 5) => {
  if (!scene || !elem || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
  let stopped = false;
  const stop = () => { stopped = true; };
  for (const evt of ["pointerdown", "wheel", "touchstart"]) elem.addEventListener(evt, stop, {once: true, passive: true});
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min((now - t0) / duration, 1);
    if (stopped) return;
    scene.rotation.y = amplitude * Math.sin(2 * Math.PI * t);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
