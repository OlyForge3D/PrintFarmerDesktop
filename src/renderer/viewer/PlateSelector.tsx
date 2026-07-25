/**
 * Plate selector for multi-plate projects.
 *
 * Renders native radios so browsers supply the arrow-key navigation and roving
 * tab stop of a radio group for free. The checked radio is derived from the
 * hidden-object set rather than stored, so it always matches what is on screen -
 * including the case where a part-tree toggle leaves visibility in a state that
 * is not any single plate, which shows as "Custom".
 */

import { useId } from 'react';

import { ALL_PLATES, activePlateId } from './plateSelection';
import type { ScenePlate } from './types';

export interface PlateSelectorProps {
  plates: readonly ScenePlate[];
  hidden: ReadonlySet<string>;
  onSelect: (plateId: string) => void;
}

export function PlateSelector({
  plates,
  hidden,
  onSelect,
}: PlateSelectorProps): React.JSX.Element | null {
  const groupName = useId();
  // A single plate is the ordinary case and needs no control.
  if (plates.length < 2) return null;

  const active = activePlateId(plates, hidden);
  const options = [
    { id: ALL_PLATES, label: 'All plates' },
    ...plates.map((plate) => ({ id: plate.id, label: plate.name })),
  ];

  return (
    <fieldset className="plate-selector">
      <legend>Plate</legend>
      <div className="plate-selector-options">
        {options.map((option) => (
          <label className="plate-selector-option" key={option.id}>
            <input
              type="radio"
              name={groupName}
              value={option.id}
              checked={active === option.id}
              onChange={() => onSelect(option.id)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {active === null ? (
        <p className="plate-selector-status" role="status">
          Custom visibility
        </p>
      ) : null}
    </fieldset>
  );
}
