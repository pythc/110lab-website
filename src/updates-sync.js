// Visible documents revalidate once per minute and immediately on resume. The deadline includes
// reading the response body; obsolete or aborted responses cannot repaint.
export function createUpdatesSync({
  request, onData, onFailure, onResume = () => {},
  isVisible = () => !document.hidden,
  setTimer = setTimeout, clearTimer = clearTimeout,
  interval = 60000, timeout = 10000,
}) {
  let active = false, poll = null, flight = null;

  function cancelPoll() {
    if (poll !== null) clearTimer(poll);
    poll = null;
  }
  function cancelFlight() {
    const current = flight;
    flight = null;
    if (!current) return;
    clearTimer(current.deadline);
    current.controller.abort();
  }
  function refresh() {
    if (!active || !isVisible() || flight) return;
    cancelPoll();
    const current = {controller: new AbortController(), deadline: null};
    flight = current;
    // Start-to-start scheduling gives a 60 s poll bound, rather than adding
    // response latency to each interval.
    poll = setTimer(() => {poll = null; refresh();}, interval);
    const fail = () => {
      if (flight !== current) return;
      cancelFlight();
      if (active && isVisible()) onFailure();
    };
    current.deadline = setTimer(fail, timeout);
    Promise.resolve().then(() => {
      if (flight === current) return request(current.controller.signal);
    }).then(data => {
      if (flight !== current || !active || !isVisible()) return;
      onData(data);
      clearTimer(current.deadline);
      flight = null;
    }).catch(fail);
  }
  function visibilityChanged() {
    cancelPoll();
    cancelFlight();
    if (active && isVisible()) {
      // A tab may have spent hours hidden: do not display its old snapshot
      // while waiting for fresh data.
      onResume();
      refresh();
    }
  }
  return {
    start() {if (active) return; active = true; refresh();},
    refresh,
    visibilityChanged,
    stop() {active = false; cancelPoll(); cancelFlight();},
  };
}
