export interface User {
  uid: string;           
  email: string | null;
  fullName?: string;
  role?: 'admin' | 'staff';
  lastLoginAt?: string;
  createdAt?: string;
}
