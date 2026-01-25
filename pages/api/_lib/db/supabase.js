import { createClient } from '@supabase/supabase-js';

// Singleton instance
let supabase = null;

export function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabase;
}

// ============================================
// CUSTOMER QUERIES
// ============================================
export async function getCustomerById(customerId) {
  const { data } = await getSupabase()
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();
  return data;
}

export async function getCustomerBySlug(slug) {
  const { data } = await getSupabase()
    .from('customers')
    .select('*')
    .eq('slug', slug)
    .single();
  return data;
}

// ============================================
// AI CONFIG QUERIES
// ============================================
export async function getAiConfig(customerId) {
  const { data } = await getSupabase()
    .from('customer_ai_config')
    .select('*')
    .eq('customer_id', customerId)
    .single();
  return data;
}

export async function getAnalysisConfig(customerId) {
  const { data } = await getSupabase()
    .from('customer_analysis_config')
    .select('*')
    .eq('customer_id', customerId)
    .single();
  return data;
}

export async function getActiveActions(customerId) {
  const { data } = await getSupabase()
    .from('customer_actions')
    .select('*')
    .eq('customer_id', customerId)
    .eq('is_active', true)
    .order('priority', { ascending: true });
  return data || [];
}

// ============================================
// COMPANION QUERIES (for Mimre/ElderCare)
// ============================================
export async function getCompanion(customerId, companionKey) {
  const { data } = await getSupabase()
    .from('customer_companions')
    .select('*')
    .eq('customer_id', customerId)
    .eq('companion_key', companionKey)
    .eq('is_active', true)
    .single();
  return data;
}

export async function getDefaultCompanion(customerId) {
  const { data } = await getSupabase()
    .from('customer_companions')
    .select('*')
    .eq('customer_id', customerId)
    .eq('is_default', true)
    .eq('is_active', true)
    .single();
  return data;
}

// ============================================
// SESSION QUERIES
// ============================================
export async function getSession(sessionId) {
  const { data } = await getSupabase()
    .from('chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  return data;
}

export async function createSession(customerId, metadata = {}) {
  const { data, error } = await getSupabase()
    .from('chat_sessions')
    .insert({
      customer_id: customerId,
      status: 'active',
      metadata
    })
    .select()
    .single();
  
  if (error) {
    console.error('Failed to create session:', error);
    return null;
  }
  return data;
}

export async function updateSession(sessionId, updates) {
  const { error } = await getSupabase()
    .from('chat_sessions')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', sessionId);
  
  if (error) {
    console.error('Failed to update session:', error);
  }
}

export async function updateSessionMetadata(sessionId, newMetadata) {
  const { data: existing } = await getSupabase()
    .from('chat_sessions')
    .select('metadata')
    .eq('id', sessionId)
    .single();

  const merged = {
    ...(existing?.metadata || {}),
    ...newMetadata
  };

  await updateSession(sessionId, { metadata: merged });
}

// ============================================
// MESSAGE QUERIES
// ============================================
export async function saveMessage(sessionId, role, content, senderType) {
  const { error } = await getSupabase()
    .from('chat_messages')
    .insert({
      session_id: sessionId,
      role,
      content,
      sender_type: senderType
    });
  
  if (error) {
    console.error('Failed to save message:', error);
  }
}

// ============================================
// NOTIFICATION QUERIES
// ============================================
export async function notificationExists(sessionId, type) {
  const { data } = await getSupabase()
    .from('notifications')
    .select('id')
    .eq('session_id', sessionId)
    .eq('type', type)
    .single();
  return !!data;
}

export async function createNotification(notification) {
  const { data, error } = await getSupabase()
    .from('notifications')
    .insert(notification)
    .select()
    .single();
  
  if (error) {
    console.error('Failed to create notification:', error);
    return null;
  }
  return data;
}

// ============================================
// EMAIL TEMPLATE QUERIES
// ============================================
export async function getEmailTemplate(customerId, templateName) {
  const { data } = await getSupabase()
    .from('email_templates')
    .select('*')
    .eq('customer_id', customerId)
    .eq('template_name', templateName)
    .single();
  return data;
}
