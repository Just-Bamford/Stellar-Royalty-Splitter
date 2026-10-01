let active = false;

export function deprecationTrackingMiddleware() {
  active = true;
  return (req, _res, next) => {
    next();
  };
}

export function stopDeprecationTracking() {
  active = false;
}

export default { deprecationTrackingMiddleware, stopDeprecationTracking };
