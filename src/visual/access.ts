let generation: number | null = null;
export function setVisualAccess(value: number | null) { generation = value; }
export function visualAccess() { return generation; }
