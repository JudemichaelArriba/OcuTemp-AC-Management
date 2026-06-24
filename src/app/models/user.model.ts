export interface User {
  uid: string;           
  email: string | null;
  fullName?: string;
  role?: 'admin' | 'staff';
  approved: boolean;
  emailVerified?: boolean;
  lastLoginAt?: string;
  createdAt?: string;
}
