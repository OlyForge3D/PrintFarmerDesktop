/**
 * Plate selector for multi-plate projects.
 *
 * Renders native radios so browsers supply the arrow-key navigation and roving
 * tab stop of a radio group for free. The checked radio is derived from the
 * hidden-object set rather than stored, so it always matches what is on screen -
 * including the case where a part-tree toggle leaves visibility in a state that
 * is not any single plate, which shows as "Custom".
 */

import { useId, useMemo } from 'react';

import { ALL_PLATES, activePlateId } from './plateSelection';
import type { PlateSelection } from './plateSelection';
import type { SceneObject, ScenePlate } from './types';

export interface PlateSelectorProps {
  plates: readonly ScenePlate[];
  objects: readonly SceneObject[];
  hidden: ReadonlySet<string>;
  onSelect: (selection: PlateSelection) => void;
}

export function PlateSelector({
  plates,
  objects,
  hidden,
  onSelect,
}: PlateSelectorProps): React.JSX.Element | null {
  const groupName = useId();
  // Two plates sharing an id are indistinguishable downstream - selecting
  // either produces the same hidden set - so they get one radio. Rendering both
  // would only duplicate a React key and check two radios at once.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const unique: ScenePlate[] = [];
    for (const plate of plates) {
      if (seen.has(plate.id)) continue;
      seen.add(plate.id);
      unique.push(plate);
    }
    return unique;
  }, [plates]);
  // A single plate is the ordinary case and needs no control. The guard has to
  // sit inside the memo, not below it: the rules of hooks would otherwise run
  // the whole scene-wide resolve before an early return threw the answer away,
  // making every single-plate scene pay for a control it never renders.
  const active = useMemo(
    () =>
      options.length < 2 ? ALL_PLATES : activePlateId(options, objects, hidden),
    [options, objects, hidden],
  );
  if (options.length < 2) return null;

  const selected = active.kind === 'plate' ? active.plateId : null;

  return (
    <fieldset className="plate-selector">
      <legend>Plate</legend>
      <div className="plate-selector-options">
        <label className="plate-selector-option">
          <input
            type="radio"
            name={groupName}
            value="all"
            checked={active.kind === 'all'}
            onChange={() => onSelect(ALL_PLATES)}
          />
          <span>All plates</span>
        </label>
        {options.map((plate) => (
          <label className="plate-selector-option" key={plate.id}>
            <input
              type="radio"
              name={groupName}
              value={plate.id}
              checked={selected === plate.id}
              onChange={() => onSelect({ kind: 'plate', plateId: plate.id })}
            />
            <span>{plate.name}</span>
          </label>
        ))}
      </div>
      {active.kind === 'custom' ? (
        <p className="plate-selector-status" role="status">
          Custom visibility
        </p>
      ) : null}
    </fieldset>
  );
}
