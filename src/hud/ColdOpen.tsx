import { useEffect, useRef } from 'react';
import type { ApproachSegment } from '../scene/approachLive';
import { formatLaunchClock, launchLive, type LaunchBeat } from '../mission/launch';
import { useT } from '../i18n';

// Shown over the approach flight until the briefing card is allowed in.
// Pointer events stay off so Skip and the language control keep working.
// The line follows the picture: boarding, countdown and climb on Earth, then the cruise, then Mars.
export function ColdOpen({ segment, beat }: { segment: ApproachSegment; beat: LaunchBeat }) {
  const tr = useT();
  const copy = segment === 'transit' ? COPY.transit : segment === 'mars' ? COPY.mars : COPY[beat];
  return (
    <div className={'cold-open' + (segment === 'earth' ? ' is-launch' : '')}>
      <p className="u">{tr.t(copy.kicker)}</p>
      <h2 key={copy.title}>{tr.t(copy.title)}</h2>
      <p key={copy.line}>{tr.m(copy.line)}</p>
    </div>
  );
}

const COPY = {
  boarding: { kicker: 'launch.kicker', title: 'launch.boarding.title', line: 'launch.boarding.line' },
  armRetract: { kicker: 'launch.kicker', title: 'launch.armRetract.title', line: 'launch.armRetract.line' },
  countdown: { kicker: 'launch.kicker', title: 'launch.countdown.title', line: 'launch.countdown.line' },
  ascent: { kicker: 'earthlaunch.kicker', title: 'earthlaunch.title', line: 'earthlaunch.line' },
  transit: { kicker: 'transit.kicker', title: 'transit.title', line: 'transit.line' },
  mars: { kicker: 'coldopen.kicker', title: 'coldopen.title', line: 'coldopen.line' },
} as const;

// Clock, altitude, speed and the current event during the launch. Numbers update every frame
// from the scene's live store, without re-rendering React.
export function LaunchTelemetry() {
  const tr = useT();
  const clock = useRef<HTMLElement>(null);
  const altitude = useRef<HTMLElement>(null);
  const speed = useRef<HTMLElement>(null);
  const event = useRef<HTMLElement>(null);
  const trRef = useRef(tr);
  useEffect(() => { trRef.current = tr; }, [tr]);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const current = trRef.current;
      const km = launchLive.altitudeKm;
      if (clock.current) clock.current.textContent = formatLaunchClock(launchLive.clock);
      if (altitude.current) altitude.current.textContent = km >= 1 ? current.t('edl.unit.km', { value: current.n(km, 1) }) : current.t('edl.unit.m', { value: Math.max(0, Math.round(km * 1000)) });
      if (speed.current) speed.current.textContent = current.t('edl.unit.kmh', { value: Math.round(launchLive.speedKmh) });
      if (event.current) event.current.textContent = current.t(`launch.event.${launchLive.event}`);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      <div className="edl-telemetry launch-telemetry" aria-live="off">
        <div><small className="u">{tr.t('launch.clock')}</small><b ref={clock}>—</b></div>
        <div><small className="u">{tr.t('edl.altitude')}</small><b ref={altitude}>—</b></div>
        <div><small className="u">{tr.t('edl.speed')}</small><b ref={speed}>—</b></div>
        <div className="edl-event"><small className="u">{tr.t('edl.event')}</small><b className="u" ref={event}>—</b></div>
      </div>
      <div className="edl-disclaimer launch-disclaimer"><span className="u">{tr.t('edl.disclaimerLead')}</span> · {tr.t('launch.disclaimer')}</div>
    </>
  );
}
