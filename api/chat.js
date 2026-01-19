import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Superadmin email for test notifications
const SUPERADMIN_EMAIL = 'eric@eryai.tech';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Test-Mode');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check if test mode
  const isTestMode = req.headers['x-test-mode'] === 'true';
  if (isTestMode) {
    console.log('🧪 TEST MODE ENABLED');
  }

  const { prompt, history, sessionId, customerId, slug } = req.body || {};
  
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }

  // ============================================
  // STEP 1: Identify customer
  // ============================================
  let customer = null;
  
  if (customerId) {
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customerId)
      .single();
    customer = data;
  } else if (slug) {
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('slug', slug)
      .single();
    customer = data;
  }
  
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  
  console.log(`🏢 Customer identified: ${customer.name} (${customer.id})`);

  // ============================================
  // STEP 2: Load AI config
  // ============================================
  const { data: aiConfig, error: configError } = await supabase
    .from('customer_ai_config')
    .select('*')
    .eq('customer_id', customer.id)
    .single();
  
  if (configError || !aiConfig) {
    console.error('No AI config found for customer:', customer.id);
    return res.status(500).json({ error: 'AI configuration not found' });
  }
  
  console.log(`🤖 AI loaded: ${aiConfig.ai_name} (${aiConfig.ai_role})`);

  // ============================================
  // STEP 3: Load actions (behavior rules)
  // ============================================
  const { data: actions } = await supabase
    .from('customer_actions')
    .select('*')
    .eq('customer_id', customer.id)
    .eq('is_active', true)
    .order('priority', { ascending: true });
  
  console.log(`📋 Loaded ${actions?.length || 0} actions`);

  // ============================================
  // STEP 4: Load analysis config
  // ============================================
  const { data: analysisConfig } = await supabase
    .from('customer_analysis_config')
    .select('*')
    .eq('customer_id', customer.id)
    .single();

  // ============================================
  // STEP 5: Check for keyword-triggered actions
  // ============================================
  const promptLower = prompt.toLowerCase();
  const triggeredActions = [];
  
  for (const action of (actions || [])) {
    if (action.trigger_type === 'analysis') continue; // Skip analysis triggers for now
    
    let triggered = false;
    
    if (action.trigger_type === 'keyword') {
      triggered = promptLower.includes(action.trigger_value.toLowerCase());
    } else if (action.trigger_type === 'regex') {
      try {
        const regex = new RegExp(action.trigger_value, 'i');
        triggered = regex.test(prompt);
      } catch (e) {
        console.error('Invalid regex:', action.trigger_value);
      }
    }
    
    if (triggered) {
      triggeredActions.push(action);
      console.log(`⚡ Action triggered: ${action.action_type} (${action.trigger_value})`);
    }
  }

  // ============================================
  // STEP 6: Create or get session
  // ============================================
  let currentSessionId = sessionId;
  
  if (!currentSessionId) {
    const { data: newSession, error: sessionError } = await supabase
      .from('chat_sessions')
      .insert({
        customer_id: customer.id,
        status: 'active',
        metadata: { 
          source: 'eryai-engine',
          is_test: isTestMode
        }
      })
      .select()
      .single();
    
    if (sessionError) {
      console.error('Failed to create session:', sessionError);
    } else {
      currentSessionId = newSession.id;
      console.log(`📝 New session created: ${currentSessionId}`);
    }
  }

  // ============================================
  // STEP 7: Check if human took over
  // ============================================
  let humanTookOver = false;
  
  if (currentSessionId && history && Array.isArray(history)) {
    const recentHistory = history.slice(-3);
    humanTookOver = recentHistory.some(msg => msg.sender_type === 'human');
    
    if (humanTookOver) {
      console.log('👤 Human took over - AI will not respond');
    }
  }

  // Save user message
  if (currentSessionId) {
    await supabase.from('chat_messages').insert({
      session_id: currentSessionId,
      role: 'user',
      content: prompt,
      sender_type: 'user'
    });
  }

  // If human took over, return empty response
  if (humanTookOver) {
    return res.status(200).json({
      response: '',
      sessionId: currentSessionId,
      humanTookOver: true
    });
  }

  // ============================================
  // STEP 8: Build system prompt with knowledge
  // ============================================
  let systemPrompt = aiConfig.system_prompt || '';
  
  // Add knowledge base
  if (aiConfig.knowledge_base) {
    systemPrompt += `\n\n## KUNSKAP (använd denna info för att svara):\n${aiConfig.knowledge_base}`;
  }
  
  // Add context from triggered actions
  for (const action of triggeredActions) {
    if (action.action_type === 'add_context' && action.action_config?.text) {
      systemPrompt += `\n\n## EXTRA INSTRUKTION:\n${action.action_config.text}`;
    }
  }

  // ============================================
  // STEP 9: Build conversation for Gemini
  // ============================================
  const contents = [];
  
  // System prompt as first user message
  contents.push({
    role: 'user',
    parts: [{ text: systemPrompt }]
  });
  
  // AI greeting
  contents.push({
    role: 'model',
    parts: [{ text: aiConfig.greeting || 'Hej! Hur kan jag hjälpa dig?' }]
  });
  
  // History
  if (history && Array.isArray(history)) {
    for (const msg of history) {
      if (msg.sender_type === 'human') {
        contents.push({
          role: 'user',
          parts: [{ text: `[PERSONALENS SVAR: "${msg.content}"]` }]
        });
        contents.push({
          role: 'model',
          parts: [{ text: 'Jag noterar att personalen har svarat.' }]
        });
      } else {
        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }]
        });
      }
    }
  }
  
  // Current prompt
  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  // ============================================
  // STEP 10: Call Gemini API
  // ============================================
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'Gemini API key missing' });
  }

  let aiResponse = '';
  
  try {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: aiConfig.temperature || 0.7,
            maxOutputTokens: aiConfig.max_tokens || 500,
            topP: 0.9
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error('Gemini error:', geminiResponse.status, errorText);
      return res.status(500).json({ error: 'AI service error' });
    }

    const geminiData = await geminiResponse.json();
    aiResponse = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // ============================================
    // STEP 11: Save AI response
    // ============================================
    if (currentSessionId && aiResponse) {
      await supabase.from('chat_messages').insert({
        session_id: currentSessionId,
        role: 'assistant',
        content: aiResponse,
        sender_type: 'ai'
      });
      
      await supabase
        .from('chat_sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', currentSessionId);
    }

    // ============================================
    // STEP 12: Run conversation analysis (async)
    // ============================================
    if (currentSessionId && analysisConfig?.enable_analysis) {
      const fullConversation = [
        ...(history || []),
        { role: 'user', content: prompt },
        { role: 'assistant', content: aiResponse }
      ];
      
      // Check if we should run analysis
      if (fullConversation.length >= (analysisConfig.min_messages_before_analysis || 4)) {
        // Run analysis in background (don't await)
        runConversationAnalysis(
          currentSessionId,
          customer,
          aiConfig,
          analysisConfig,
          actions || [],
          fullConversation,
          aiResponse,
          isTestMode
        ).catch(err => console.error('Analysis error:', err));
      }
    }

    // ============================================
    // STEP 13: Return response
    // ============================================
    return res.status(200).json({
      response: aiResponse,
      sessionId: currentSessionId,
      customerId: customer.id,
      customerName: customer.name,
      aiName: aiConfig.ai_name,
      triggeredActions: triggeredActions.map(a => a.action_type),
      needsHandoff: false
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ============================================
// CONVERSATION ANALYSIS
// ============================================
async function runConversationAnalysis(sessionId, customer, aiConfig, analysisConfig, actions, conversation, aiResponse, isTestMode, retryCount = 0) {
  try {
    // Build recent messages text for trigger detection
    const recentMessages = conversation.slice(-4).map(m => m.content).join(' ').toLowerCase();
    
    // Check triggers from config
    const emailPattern = new RegExp(analysisConfig.email_pattern?.replace(/^\/|\/$/g, '') || '@', 'i');
    const phonePattern = new RegExp(analysisConfig.phone_pattern?.replace(/^\/|\/$/g, '') || '(\\d{3,4}[\\s-]?\\d{2,3}[\\s-]?\\d{2,4}|\\d{10,})', 'i');
    
    const complaintKeywords = (analysisConfig.complaint_keywords || '').split(',').map(k => k.trim().toLowerCase());
    const humanKeywords = (analysisConfig.human_request_keywords || '').split(',').map(k => k.trim().toLowerCase());
    const specialKeywords = (analysisConfig.special_request_keywords || '').split(',').map(k => k.trim().toLowerCase());
    const unsurePatterns = (analysisConfig.ai_unsure_patterns || '').split(',').map(k => k.trim().toLowerCase());
    
    const hasEmail = emailPattern.test(recentMessages);
    const hasPhone = phonePattern.test(recentMessages);
    const hasComplaint = complaintKeywords.some(k => k && recentMessages.includes(k));
    const wantsHuman = humanKeywords.some(k => k && recentMessages.includes(k));
    const hasSpecialRequest = specialKeywords.some(k => k && recentMessages.includes(k));
    const aiUnsure = unsurePatterns.some(p => p && aiResponse.toLowerCase().includes(p));
    
    // Only run Gemini analysis if triggers detected
    if (!hasEmail && !hasPhone && !hasComplaint && !wantsHuman && !hasSpecialRequest && !aiUnsure) {
      console.log('No analysis triggers detected');
      return;
    }
    
    console.log('🔍 Analysis triggers:', { hasEmail, hasPhone, hasComplaint, wantsHuman, hasSpecialRequest, aiUnsure });
    
    // Build conversation text
    const conversationText = conversation
      .map(msg => `${msg.role === 'user' ? 'Gäst' : aiConfig.ai_name}: ${msg.content}`)
      .join('\n');
    
    // Analyze with Gemini
    const analysisPrompt = `Analysera denna restaurangkonversation noggrant:

${conversationText}

Avgör:
1. Om det finns en KOMPLETT reservation (datum + tid + antal + namn + kontakt)
2. Om gästen ställt en fråga som ${aiConfig.ai_name} INTE kunde svara på
3. Om gästen uttryckt missnöje eller klagomål
4. Om gästen explicit bett att prata med personal/chef

Svara ENDAST med JSON (ingen annan text):
{
  "reservation_complete": true/false,
  "needs_human_response": true/false,
  "needs_human_reason": "anledning eller null",
  "is_complaint": true/false,
  "guest_name": "namn eller null",
  "guest_email": "email eller null",
  "guest_phone": "telefon eller null",
  "reservation_date": "datum/veckodag eller null",
  "reservation_time": "tid eller null",
  "party_size": antal eller null,
  "special_requests": "allergier/önskemål eller null"
}`;

    const API_KEY = process.env.GEMINI_API_KEY;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
        })
      }
    );

    // Handle rate limit with retry
    if (response.status === 429) {
      if (retryCount < 3) {
        const waitTime = Math.pow(2, retryCount) * 1000;
        console.log(`Rate limited, retrying in ${waitTime}ms (attempt ${retryCount + 1}/3)`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return runConversationAnalysis(sessionId, customer, aiConfig, analysisConfig, actions, conversation, aiResponse, isTestMode, retryCount + 1);
      }
      console.error('Analysis failed after 3 retries due to rate limiting');
      return;
    }

    if (!response.ok) {
      console.error('Analysis API error:', response.status);
      return;
    }

    const analysisData = await response.json();
    const analysisText = analysisData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Parse JSON from response
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('No JSON found in analysis');
      return;
    }

    const analysis = JSON.parse(jsonMatch[0]);
    console.log('📊 Conversation analysis:', analysis);

    // Update session with guest info
    if (analysis.guest_name || analysis.guest_email || analysis.guest_phone) {
      await updateSessionWithGuestInfo(sessionId, analysis);
    }

    // Get analysis-triggered actions
    const analysisActions = actions.filter(a => a.trigger_type === 'analysis');
    
    // Determine which analysis triggers fired
    const firedTriggers = [];
    if (analysis.reservation_complete && analysis.guest_name && (analysis.guest_email || analysis.guest_phone)) {
      firedTriggers.push('reservation_complete');
    }
    if (analysis.is_complaint) {
      firedTriggers.push('is_complaint');
    }
    if (analysis.needs_human_response && !analysis.reservation_complete && !analysis.is_complaint) {
      firedTriggers.push('needs_human_response');
    }

    console.log('🎯 Fired triggers:', firedTriggers);

    // Execute actions for each fired trigger
    for (const trigger of firedTriggers) {
      const matchingActions = analysisActions.filter(a => a.trigger_value === trigger);
      
      for (const action of matchingActions) {
        await executeAction(action, {
          sessionId,
          customer,
          aiConfig,
          analysisConfig,
          analysis,
          isTestMode
        });
      }
    }

  } catch (err) {
    console.error('Conversation analysis error:', err);
  }
}

// ============================================
// UPDATE SESSION WITH GUEST INFO
// ============================================
async function updateSessionWithGuestInfo(sessionId, analysis) {
  try {
    const { data: existingSession } = await supabase
      .from('chat_sessions')
      .select('metadata')
      .eq('id', sessionId)
      .single();

    const updatedMetadata = {
      ...(existingSession?.metadata || {}),
      guest_name: analysis.guest_name || existingSession?.metadata?.guest_name,
      guest_email: analysis.guest_email || existingSession?.metadata?.guest_email,
      guest_phone: analysis.guest_phone || existingSession?.metadata?.guest_phone,
      source: 'eryai-engine'
    };

    await supabase
      .from('chat_sessions')
      .update({ 
        metadata: updatedMetadata,
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId);

    console.log('✅ Session updated with guest info:', analysis.guest_name);
  } catch (err) {
    console.error('Failed to update session with guest info:', err);
  }
}

// ============================================
// EXECUTE ACTION
// ============================================
async function executeAction(action, context) {
  const { sessionId, customer, aiConfig, analysisConfig, analysis, isTestMode } = context;
  
  console.log(`⚙️ Executing action: ${action.action_type} for trigger: ${action.trigger_value}`);
  
  try {
    switch (action.action_type) {
      case 'create_notification':
        await createNotification(action, context);
        break;
        
      case 'email_staff':
        await sendStaffEmail(action, context);
        break;
        
      case 'email_guest':
        await sendGuestEmail(action, context);
        break;
        
      case 'handoff':
        await supabase
          .from('chat_sessions')
          .update({ needs_human: true })
          .eq('id', sessionId);
        console.log('✅ Session marked for handoff');
        break;
        
      default:
        console.log(`Unknown action type: ${action.action_type}`);
    }
  } catch (err) {
    console.error(`Error executing action ${action.action_type}:`, err);
  }
}

// ============================================
// CREATE NOTIFICATION
// ============================================
async function createNotification(action, context) {
  const { sessionId, customer, analysis } = context;
  const config = action.action_config || {};
  
  // Check if notification already exists
  const { data: existing } = await supabase
    .from('notifications')
    .select('id')
    .eq('session_id', sessionId)
    .eq('type', config.type)
    .single();
    
  if (existing) {
    console.log(`Notification type ${config.type} already exists for session`);
    return;
  }
  
  // Build summary based on type
  let summary = '';
  if (config.type === 'reservation') {
    summary = `Reservation ${analysis.reservation_date} kl ${analysis.reservation_time}, ${analysis.party_size} pers`;
    if (analysis.special_requests) summary += `, ${analysis.special_requests}`;
  } else if (config.type === 'complaint') {
    summary = analysis.needs_human_reason || 'Gäst har uttryckt missnöje';
  } else {
    summary = analysis.needs_human_reason || 'Gäst har frågor som behöver svar';
  }
  
  const { data: notification, error } = await supabase
    .from('notifications')
    .insert({
      customer_id: customer.id,
      session_id: sessionId,
      type: config.type,
      priority: config.priority || 'normal',
      status: 'unread',
      summary,
      guest_name: analysis.guest_name,
      guest_email: analysis.guest_email,
      guest_phone: analysis.guest_phone,
      reservation_details: config.type === 'reservation' ? {
        date: analysis.reservation_date,
        time: analysis.reservation_time,
        party_size: analysis.party_size,
        special_requests: analysis.special_requests
      } : null
    })
    .select()
    .single();
    
  if (error) {
    console.error('Failed to create notification:', error);
    return;
  }
  
  // Mark session as needs_human
  await supabase
    .from('chat_sessions')
    .update({ needs_human: true })
    .eq('id', sessionId);
  
  console.log(`✅ Notification created: ${notification.id} (${config.type})`);
}

// ============================================
// SEND STAFF EMAIL
// ============================================
async function sendStaffEmail(action, context) {
  const { sessionId, customer, aiConfig, analysisConfig, analysis, isTestMode } = context;
  const config = action.action_config || {};
  
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.log('RESEND_API_KEY not set, skipping email');
    return;
  }
  
  // Get email template
  const { data: template } = await supabase
    .from('email_templates')
    .select('*')
    .eq('customer_id', customer.id)
    .eq('template_name', config.template)
    .single();
    
  if (!template) {
    console.error(`Email template not found: ${config.template}`);
    return;
  }
  
  // Build template variables
  const guestContact = analysis.guest_email || analysis.guest_phone || 'Ej angiven';
  const vars = {
    ai_name: aiConfig.ai_name,
    customer_name: customer.name,
    guest_name: analysis.guest_name || 'Okänd gäst',
    guest_contact: guestContact,
    session_id: sessionId,
    reservation_date: analysis.reservation_date || '',
    reservation_time: analysis.reservation_time || '',
    party_size: analysis.party_size || '',
    special_requests: analysis.special_requests || '',
    summary: analysis.needs_human_reason || 'Gästen behöver hjälp'
  };
  
  // Simple template replacement
  let subject = template.subject;
  let html = template.html_body;
  
  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    subject = subject.replace(regex, value || '');
    html = html.replace(regex, value || '');
  }
  
  // Handle conditional sections (simple {{#key}}...{{/key}})
  html = html.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
    return vars[key] ? content : '';
  });
  
  // Determine recipient
  const toEmail = isTestMode ? SUPERADMIN_EMAIL : (analysisConfig?.staff_email || SUPERADMIN_EMAIL);
  const testPrefix = isTestMode ? '[TEST] ' : '';
  
  try {
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${aiConfig.ai_name} <${analysisConfig?.from_email || 'sofia@eryai.tech'}>`,
        to: toEmail,
        reply_to: customer.metadata?.reply_to_email,
        subject: testPrefix + subject,
        html
      })
    });
    
    const result = await emailResponse.json();
    
    if (emailResponse.ok) {
      console.log(`✅ Staff email sent: ${result.id} (to: ${toEmail})`);
    } else {
      console.error('Resend API error:', emailResponse.status, result);
    }
  } catch (err) {
    console.error('Failed to send staff email:', err);
  }
}

// ============================================
// SEND GUEST EMAIL
// ============================================
async function sendGuestEmail(action, context) {
  const { sessionId, customer, aiConfig, analysisConfig, analysis, isTestMode } = context;
  const config = action.action_config || {};
  
  // Only send if we have guest email
  if (!analysis.guest_email) {
    console.log('No guest email, skipping guest notification');
    return;
  }
  
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.log('RESEND_API_KEY not set, skipping email');
    return;
  }
  
  // Get email template
  const { data: template } = await supabase
    .from('email_templates')
    .select('*')
    .eq('customer_id', customer.id)
    .eq('template_name', config.template)
    .single();
    
  if (!template) {
    console.error(`Email template not found: ${config.template}`);
    return;
  }
  
  // Build template variables
  const vars = {
    ai_name: aiConfig.ai_name,
    customer_name: customer.name,
    customer_tagline: customer.metadata?.tagline || '',
    customer_address: customer.metadata?.address || '',
    customer_phone: customer.metadata?.phone || '',
    guest_name: analysis.guest_name || 'Gäst',
    reservation_date: analysis.reservation_date || '',
    reservation_time: analysis.reservation_time || '',
    party_size: analysis.party_size || '',
    special_requests: analysis.special_requests || ''
  };
  
  // Simple template replacement
  let subject = template.subject;
  let html = template.html_body;
  
  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    subject = subject.replace(regex, value || '');
    html = html.replace(regex, value || '');
  }
  
  // Handle conditional sections
  html = html.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
    return vars[key] ? content : '';
  });
  
  // In test mode, send to superadmin instead
  const toEmail = isTestMode ? SUPERADMIN_EMAIL : analysis.guest_email;
  const testPrefix = isTestMode ? '[TEST GUEST EMAIL] ' : '';
  
  try {
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${customer.name} <${analysisConfig?.from_email || 'sofia@eryai.tech'}>`,
        to: toEmail,
        reply_to: customer.metadata?.reply_to_email,
        subject: testPrefix + subject,
        html
      })
    });
    
    const result = await emailResponse.json();
    
    if (emailResponse.ok) {
      console.log(`✅ Guest email sent: ${result.id} (to: ${toEmail})`);
    } else {
      console.error('Resend API error:', emailResponse.status, result);
    }
  } catch (err) {
    console.error('Failed to send guest email:', err);
  }
}
