/**
 * API Service
 * Centralized HTTP client for backend API calls.
 * Automatically attaches the Supabase auth token to requests.
 */
import axios from 'axios';
import { supabase } from './supabase';

const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const api = axios.create({
  baseURL: `${apiUrl}/api`,
  headers: { 'Content-Type': 'application/json' },
});

/** Attach auth token to every request */
api.interceptors.request.use(async (config) => {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;
