/** A brief swing of the scene that settles back to the initial view, so the brain visibly reads as 3D. */
export const spinHint = (scene, elem, duration = 2200, amplitude = Math.PI / 5) => {
  if (!scene || !elem || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
  let stopped = false;
  const stop = () => { stopped = true; };
  for (const evt of ["pointerdown", "wheel", "touchstart"]) elem.addEventListener(evt, stop, {once: true, passive: true});
  // the brain mesh arrives after the scene is created: start the swing once it is there (give up after 30 s)
  const hasBrain = () => scene.children.some((c) => c.isMesh && c.material && c.material.type === "ShaderMaterial");
  const tWait = performance.now();
  let t0 = null;
  const step = (now) => {
    if (stopped) return;
    if (t0 === null) {
      if (!hasBrain()) {
        if (now - tWait < 30000) requestAnimationFrame(step);
        return;
      }
      t0 = now;
    }
    const t = Math.min((now - t0) / duration, 1);
    if (stopped) return;
    scene.rotation.y = amplitude * Math.sin(2 * Math.PI * t);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
