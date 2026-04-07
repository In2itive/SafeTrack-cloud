import React, { createContext, useContext, useState, useEffect } from 'react';
import { db } from '../services/db';
import { User, UserRole } from '../types';
import { hashPassword } from '../utils/auth';

interface AuthContextType {
  user: User | null;
  secondaryUser: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSetupRequired: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  registerFirstUser: (username: string, name: string, email: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [secondaryUser, setSecondaryUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSetupRequired, setIsSetupRequired] = useState(false);

  useEffect(() => {
    checkSetup();
  }, []);

  const checkSetup = async () => {
    try {
      const count = await db.users.count();
      if (count === 0) {
        setIsSetupRequired(true);
      } else {
        // Check for existing session (simple localStorage persistence for demo)
        const storedUserId = localStorage.getItem('currentUserId');
        if (storedUserId) {
          const currentUser = await db.users.get(parseInt(storedUserId));
          if (currentUser) {
            setUser(currentUser);
          }
        }
        const storedSecondaryUserId = localStorage.getItem('secondaryUserId');
        if (storedSecondaryUserId) {
          const secondUser = await db.users.get(parseInt(storedSecondaryUserId));
          if (secondUser) {
            setSecondaryUser(secondUser);
          }
        }
      }
    } catch (error) {
      console.error("Auth check failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string): Promise<boolean> => {
    const hashedPassword = await hashPassword(password);
    const foundUser = await db.users.where('username').equals(username).first();

    if (foundUser && foundUser.passwordHash === hashedPassword) {
      if (!user) {
        setUser(foundUser);
        localStorage.setItem('currentUserId', foundUser.id!.toString());
      } else {
        if (foundUser.id === user.id) {
          return false; // Cannot be the same user
        }
        setSecondaryUser(foundUser);
        localStorage.setItem('secondaryUserId', foundUser.id!.toString());
      }
      return true;
    }
    return false;
  };

  const logout = () => {
    setUser(null);
    setSecondaryUser(null);
    localStorage.removeItem('currentUserId');
    localStorage.removeItem('secondaryUserId');
  };

  const registerFirstUser = async (username: string, name: string, email: string, password: string) => {
    const hashedPassword = await hashPassword(password);
    const newUser: User = {
      username,
      name,
      email,
      role: UserRole.Administrator,
      passwordHash: hashedPassword
    };
    
    const id = await db.users.add(newUser);
    const createdUser = { ...newUser, id: id as number };
    
    setUser(createdUser);
    localStorage.setItem('currentUserId', id.toString());
    setIsSetupRequired(false);
  };

  const isAuthenticated = !!user && (user.role === UserRole.Administrator || !!secondaryUser);

  return (
    <AuthContext.Provider value={{ user, secondaryUser, isAuthenticated, isLoading, isSetupRequired, login, logout, registerFirstUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
