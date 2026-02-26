export interface Room {
  uid: string;                
  roomName: string;            
  status: 'active' | 'inactive'; 
  temperature?: number;     
  humidity?: number;        
  device?: string;             
  occupancy?: boolean;     
  createdAt?: string;          
  updatedAt?: string;          
} 