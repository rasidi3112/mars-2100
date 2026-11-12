import { useT } from '../i18n';

// Shown over the approach flight until the briefing card is allowed in.
// Pointer events stay off so Skip and the language control keep working.
export function ColdOpen() {
  const tr = useT();
  return (
    <div className="cold-open">
      <p className="u">{tr.t('coldopen.kicker')}</p>
      <h2>{tr.t('coldopen.title')}</h2>
      <p>{tr.m('coldopen.line')}</p>
    </div>
  );
}
