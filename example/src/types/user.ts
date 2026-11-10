export type Role = 'admin' | 'member';

export enum Plan {
  Free = 'free',
  Pro = 'pro',
}

/** A registered user. */
export interface UserDto {
  id: string;
  name: string;
  email: string;
  age?: number;
  role: Role;
  plan: Plan;
  createdAt: Date;
  nickname: string | null;
}

export interface ErrorDto {
  message: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
}
