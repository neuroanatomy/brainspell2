/**
 * A slow, constant spin of the 3D brain (one turn per `period` ms), so it visibly reads as 3D.
 * It moves the camera around the controls' target, exactly as TrackballControls does when the user drags:
 * the brain, the coordinates and the cluster surface then turn together, and the light follows the camera.
 * (Rotating the scene or its meshes does not work: the camera is a child of the scene, and the coordinate
 * spheres are offset from the origin, so they would turn on themselves instead of around the brain.)
 * The spin axis is the camera's up vector. If the user rotates the brain, the spin continues in the
 * direction of the user's motion. It pauses while the user is pressing on the viewer.
 */
export const spinHint = (tr, elem, period = 20000) => {
  if (!tr || !tr.camera || !tr.cameraControls || !elem || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
  const {camera, cameraControls: controls} = tr;
  const {THREE} = window;
  const speed = 2 * Math.PI / period;
  const minUserTurn = 1e-4; // rad per frame: below this the camera is considered not moved by the user
  let direction = -1; // camera yaw sign: -1 makes the brain turn counter-clockwise seen from above
  let pressed = false;
  const press = () => { pressed = true; };
  const release = () => { pressed = false; };
  for (const evt of ["pointerdown", "touchstart"]) elem.addEventListener(evt, press, {passive: true});
  for (const evt of ["pointerup", "pointercancel", "touchend", "touchcancel"]) window.addEventListener(evt, release, {passive: true});

  const eye = new THREE.Vector3();
  const prevEye = new THREE.Vector3().subVectors(camera.position, controls.target);
  const axis = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let last = null;

  // signed angle between two eye vectors around the camera's up axis
  const yaw = (from, to, up) => {
    a.copy(from).addScaledVector(up, -from.dot(up));
    b.copy(to).addScaledVector(up, -to.dot(up));

    return Math.atan2(up.dot(c.crossVectors(a, b)), a.dot(b));
  };

  const step = (now) => {
    requestAnimationFrame(step);
    const dt = last === null ? 0 : Math.min(now - last, 100); // ms, capped after a pause
    last = now;
    axis.copy(camera.up).normalize();
    eye.subVectors(camera.position, controls.target);

    // whatever moved the camera since our last step was the user (drag or its inertia): follow its direction
    const user = yaw(prevEye, eye, axis);
    if (Math.abs(user) > minUserTurn) {
      direction = Math.sign(user);
    }

    if (!pressed && dt > 0) {
      q.setFromAxisAngle(axis, direction * speed * dt);
      eye.applyQuaternion(q);
      camera.up.applyQuaternion(q);
      camera.position.addVectors(controls.target, eye);
    }
    prevEye.copy(eye);
  };
  requestAnimationFrame(step);
};
