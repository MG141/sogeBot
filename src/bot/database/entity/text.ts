import { EntitySchema } from 'typeorm';

export interface TextInterface {
  id?: string;
  name: string;
  refreshRate: number;
  text: string;
  css: string;
  js: string;
  external: string[];
}

export const Text = new EntitySchema<Readonly<Required<TextInterface>>>({
  name: 'text',
  columns: {
    id: { type: String, primary: true, generated: 'uuid' },
    name: { type: String },
    refreshRate: { type: Number, default: 5 },
    text: { type: 'text' },
    css: { type: 'text' },
    js: { type: 'text' },
    external: { type: 'simple-array' },
  },
});