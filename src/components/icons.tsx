import type { ReactNode } from "react";

export type IconName =
  | "grid"
  | "home"
  | "document"
  | "task"
  | "bell"
  | "settings"
  | "search"
  | "user"
  | "chevron"
  | "trash"
  | "upload";
const shapes: Record<IconName, ReactNode> = {
  grid: (
    <g fill="currentColor" stroke="none">
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="8" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
    </g>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v11h5v-7h4v7h5V10" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H5v18h14V8l-5-5Z" />
      <path d="M14 3v5h5M8 12h8M8 16h6" />
    </>
  ),
  task: (
    <>
      <rect x="5" y="5" width="14" height="16" rx="2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="m8 13 3 3 5-6" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9ZM10 21h4" />
    </>
  ),
  settings: (
    <>
      <path
        d="m9 3 6 0 .6 2.4 2.2 1.3 2.3-.7 3 5-1.7 1.8v2.5l1.7 1.8-3 5-2.3-.7-2.2 1.3L15 24H9l-.6-2.3-2.2-1.3-2.3.7-3-5 1.7-1.8v-2.5L.9 11l3-5 2.3.7 2.2-1.3L9 3Z"
        transform="translate(2 -1) scale(.83)"
      />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  user: (
    <g fill="currentColor" stroke="none">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 23v-3a8 8 0 0 1 16 0v3Z" />
    </g>
  ),
  trash: (
    <>
      <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
    </>
  ),
  upload: (
    <>
      <path d="M7 18H5a4 4 0 0 1-.4-8 7 7 0 0 1 13.7-2A5 5 0 0 1 19 18h-2M12 21V11m-4 4 4-4 4 4" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
};
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className={`icon icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}
