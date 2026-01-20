import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Test-Mode');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(session_id)) {
    return res.status(400).json({ error: 'Invalid session_id format' });
  }

  // GET - Check typing status
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('chat_sessions')
        .select('visitor_typing, staff_typing')
        .eq('id', session_id)
        .single();

      if (error) {
        return res.status(200).json({ visitor_typing: false, staff_typing: false });
      }

      return res.status(200).json({
        visitor_typing: data?.visitor_typing || false,
        staff_typing: data?.staff_typing || false
      });
    } catch (error) {
      console.error('Typing GET error:', error);
      return res.status(200).json({ visitor_typing: false, staff_typing: false });
    }
  }

  // POST - Update typing status
  if (req.method === 'POST') {
    const { typing, sender } = req.body;

    if (typeof typing !== 'boolean' || !['visitor', 'staff'].includes(sender)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    try {
      const updateData = sender === 'visitor'
        ? { visitor_typing: typing }
        : { staff_typing: typing };

      const { error } = await supabase
        .from('chat_sessions')
        .update(updateData)
        .eq('id', session_id);

      if (error) {
        console.error('Typing update error:', error);
        return res.status(500).json({ error: 'Failed to update typing status' });
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Server error:', error);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
