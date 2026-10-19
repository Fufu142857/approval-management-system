"use client";
import { createContext, useContext } from "react";
export const NotificationContext = createContext({
  enabled: false,
  refreshCount: () => {},
});
export const useNotifications = () => useContext(NotificationContext);
