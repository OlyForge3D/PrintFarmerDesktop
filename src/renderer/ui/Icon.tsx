import type { SVGProps } from 'react';

export type IconName =
  | 'collection'
  | 'cube'
  | 'duplicate'
  | 'file'
  | 'folder'
  | 'missing'
  | 'preview'
  | 'refresh'
  | 'reset'
  | 'search'
  | 'star'
  | 'view';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

/** Restrained line icons used by the custom desktop chrome and workspace. */
export function Icon({
  name,
  size = 16,
  ...props
}: IconProps): React.JSX.Element {
  return (
    <svg
      {...props}
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPath(name)}
    </svg>
  );
}

function iconPath(name: IconName): React.JSX.Element {
  switch (name) {
    case 'collection':
      return (
        <>
          <rect x="4" y="5" width="16" height="14" rx="1" />
          <path d="M8 9h8M8 13h8" />
        </>
      );
    case 'cube':
      return (
        <>
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
          <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </>
      );
    case 'duplicate':
      return (
        <>
          <rect x="8" y="8" width="11" height="11" rx="1" />
          <path d="M16 8V5H5v11h3" />
        </>
      );
    case 'file':
      return (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v5h4" />
        </>
      );
    case 'folder':
      return (
        <>
          <path d="M3 6.5h7l2 2h9v10.5H3z" />
          <path d="M3 9h18" />
        </>
      );
    case 'missing':
      return (
        <>
          <path d="M12 3 2.8 19h18.4z" />
          <path d="M12 9v4M12 16.5h.01" />
        </>
      );
    case 'preview':
      return (
        <>
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      );
    case 'refresh':
      return (
        <>
          <path d="M20 7v5h-5" />
          <path d="M4 17v-5h5" />
          <path d="M6.1 8.2A7 7 0 0 1 18.8 10M5.2 14A7 7 0 0 0 17.9 15.8" />
        </>
      );
    case 'reset':
      return (
        <>
          <path d="M4 8v5h5" />
          <path d="M5.5 16a8 8 0 1 0 .2-8.2L4 10" />
        </>
      );
    case 'search':
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </>
      );
    case 'star':
      return (
        <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" />
      );
    case 'view':
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="1" />
          <path d="M3 9h18M9 9v11" />
        </>
      );
  }
}
