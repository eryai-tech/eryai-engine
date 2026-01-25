import {
  getCustomerById,
  getCustomerBySlug,
  getAiConfig,
  getAnalysisConfig,
  getActiveActions,
  getCompanion,
  getSession,
  createSession,
  updateSession,
  updateSessionMetadata,
  saveMessage
} from '../db/supabase.js';

import { callGemini, buildChatContents, buildSystemPrompt } from '../ai/gemini.js';
import { shouldRunAnalysis, analyzeConversation, getFiredTriggers, analyzePromptSafety } from '../ai/analysis.js';
import { checkKeywordTriggers, executeActionsForTrigger } from '../actions/executor.js';
import { pushNewGuestMessage } from '../notifications/push.js';
import { sendSuperadminAlert } from '../notifications/email.js';

const SUPERADMIN_EMAIL = 'eric@eryai.tech';

// Risk level threshold for blocking
const RISK_THRESHOLD_BLOCK = 7;  // 7-10 = block and alert
const RISK_THRESHOLD_LOG = 4;    // 4-6 = log but allow

// ============================================
// MAIN CHAT ENGINE
// ============================================
export async function handleChat({ prompt, history, sessionId, customerId, slug, companion, isTestMode }) {
  
  // ============================================
  // STEP 1: Identify customer
  // ============================================
  let customer = null;
  
  if (customerId) {
    customer = await getCustomerById(customerId);
  } else if (slug) {
    customer = await getCustomerBySlug(slug);
  }

  if (!customer) {
    return { error: 'Customer not found', status: 404 };
  }

  console.log(`🏢 Customer identified: ${customer.name} (${customer.id})`);

  // ============================================
  // STEP 2: Load all configs in parallel
  // ============================================
  const [aiConfig, analysisConfig, actions] = await Promise.all([
    getAiConfig(customer.id),
    getAnalysisConfig(customer.id),
    getActiveActions(customer.id)
  ]);

  if (!aiConfig) {
    console.error('No AI config found for customer:', customer.id);
    return { error: 'AI configuration not found', status: 500 };
  }

  // ============================================
  // STEP 2.5: Check for companion override (Mimre/ElderCare)
  // ============================================
  let effectiveAiConfig = aiConfig;
  let companionData = null;

  if (companion) {
    companionData = await getCompanion(customer.id, companion);
    
    if (companionData) {
      console.log(`👤 Companion loaded: ${companionData.ai_name} (${companionData.companion_key})`);
      
      // Override AI config with companion settings
      effectiveAiConfig = {
        ...aiConfig,
        ai_name: companionData.ai_name,
        ai_role: companionData.ai_role || aiConfig.ai_role,
        greeting: companionData.greeting || aiConfig.greeting,
        system_prompt: companionData.system_prompt,
        knowledge_base: companionData.knowledge_base || aiConfig.knowledge_base,
        temperature: companionData.temperature || aiConfig.temperature,
        max_tokens: companionData.max_tokens || aiConfig.max_tokens
      };
    } else {
      console.warn(`⚠️ Companion '${companion}' not found for customer ${customer.id}`);
    }
  }

  console.log(`🤖 AI loaded: ${effectiveAiConfig.ai_name} (${effectiveAiConfig.ai_role})`);
  console.log(`📋 Loaded ${actions.length} actions`);

  // ============================================
  // STEP 3: AI-POWERED SECURITY CHECK
  // Always analyze ALL messages (costs ~$0.001 per check)
  // This catches threats in ALL languages
  // ============================================
  let securityAnalysis = { suspicious: false, reason: null, riskLevel: 0 };
  
  // Determine customer type for context-aware security
  const customerType = slug?.includes('eldercare') || companion ? 'eldercare' : 'restaurant';
  
  // Always run AI security analysis
  console.log('🔍 Running AI security analysis...');
  securityAnalysis = await analyzePromptSafety(prompt, customerType);
  console.log(`🔍 Security result: Risk ${securityAnalysis.riskLevel}/10 - ${securityAnalysis.reason}`);

  const isSuspicious = securityAnalysis.riskLevel >= RISK_THRESHOLD_BLOCK;
  const isWarning = securityAnalysis.riskLevel >= RISK_THRESHOLD_LOG && securityAnalysis.riskLevel < RISK_THRESHOLD_BLOCK;

  if (isWarning) {
    console.warn(`⚠️ [SECURITY WARNING] Risk ${securityAnalysis.riskLevel}/10: "${prompt.substring(0, 50)}..." - ${securityAnalysis.reason}`);
  }

  // ============================================
  // STEP 4: Get or create session
  // ============================================
  let currentSessionId = sessionId;
  let existingSession = null;

  if (currentSessionId) {
    existingSession = await getSession(currentSessionId);
  }

  if (!currentSessionId) {
    const sessionMetadata = {
      source: 'eryai-engine',
      is_test: isTestMode
    };

    // Store companion in session metadata if used
    if (companion && companionData) {
      sessionMetadata.companion = companion;
      sessionMetadata.companion_name = companionData.ai_name;
    }

    const newSession = await createSession(customer.id, sessionMetadata);

    if (newSession) {
      currentSessionId = newSession.id;
      existingSession = newSession;
      console.log(`📝 New session created: ${currentSessionId}`);
    }
  }

  // ============================================
  // STEP 5: Handle suspicious sessions (risk >= 7)
  // ============================================
  if (isSuspicious && currentSessionId) {
    console.warn(`🚨 [SECURITY] Suspicious activity detected!`);
    console.warn(`Session: ${currentSessionId}`);
    console.warn(`Risk Level: ${securityAnalysis.riskLevel}/10`);
    console.warn(`Reason: ${securityAnalysis.reason}`);
    console.warn(`Prompt: "${prompt.substring(0, 100)}..."`);

    // Flag session and route to superadmin
    await updateSession(currentSessionId, {
      suspicious: true,
      suspicious_reason: securityAnalysis.reason,
      risk_level: securityAnalysis.riskLevel,
      routed_to_superadmin: true
    });

    // Save the suspicious message
    await saveMessage(currentSessionId, 'user', prompt, 'user');

    // Send security alert email to superadmin
    try {
      await sendSuperadminAlert({
        to: SUPERADMIN_EMAIL,
        subject: `🚨 [SECURITY] Risk ${securityAnalysis.riskLevel}/10 - ${customer.name}`,
        customerName: customer.name,
        sessionId: currentSessionId,
        reason: securityAnalysis.reason,
        riskLevel: securityAnalysis.riskLevel,
        prompt: prompt,
        isTestMode
      });
      console.log('✅ Security alert email sent to superadmin');
    } catch (emailError) {
      console.error('❌ Failed to send security alert:', emailError.message);
    }

    // Return a safe, non-technical response
    // The AI stays in character and doesn't acknowledge the security system
    const safeResponse = customerType === 'eldercare'
      ? 'Beklager, jeg forstår ikke helt hva du mener. Skal vi snakke om noe hyggelig i stedet?'
      : 'Jeg forstår dessverre ikke spørsmålet. Kan jeg hjelpe deg med noe annet?';

    // Save the safe response
    await saveMessage(currentSessionId, 'assistant', safeResponse, 'ai');

    return {
      response: safeResponse,
      sessionId: currentSessionId,
      customerId: customer.id,
      customerName: customer.name,
      aiName: effectiveAiConfig.ai_name,
      triggeredActions: [],
      needsHandoff: false,
      suspicious: true,
      riskLevel: securityAnalysis.riskLevel
    };
  }

  // ============================================
  // STEP 6: Check if human took over
  // ============================================
  let humanTookOver = false;

  // Check from history
  if (history && Array.isArray(history)) {
    const recentHistory = history.slice(-3);
    humanTookOver = recentHistory.some(msg => msg.sender_type === 'human');
  }

  // Check session flag
  if (existingSession?.needs_human) {
    humanTookOver = true;
  }

  if (humanTookOver) {
    console.log('👤 Human took over - AI will not respond');
  }

  // ============================================
  // STEP 7: Save user message
  // ============================================
  if (currentSessionId) {
    await saveMessage(currentSessionId, 'user', prompt, 'user');
    await updateSession(currentSessionId, {
      // Store risk level even for non-suspicious messages (for analytics)
      risk_level: securityAnalysis.riskLevel
    });
  }

  // ============================================
  // STEP 8: If human took over, send push and return
  // ============================================
  if (humanTookOver && currentSessionId) {
    const guestName = existingSession?.metadata?.guest_name || 'Gäst';

    // Send push notification for new guest message
    await pushNewGuestMessage(customer.id, currentSessionId, guestName, prompt);

    return {
      response: '',
      sessionId: currentSessionId,
      humanTookOver: true
    };
  }

  // ============================================
  // STEP 9: Check keyword triggers
  // ============================================
  const triggeredActions = checkKeywordTriggers(prompt, actions);

  // ============================================
  // STEP 10: Build system prompt and call AI
  // ============================================
  const systemPrompt = buildSystemPrompt(effectiveAiConfig, triggeredActions);
  const contents = buildChatContents(systemPrompt, effectiveAiConfig.greeting, history, prompt);

  let aiResponse = '';

  try {
    aiResponse = await callGemini(contents, {
      temperature: effectiveAiConfig.temperature || 0.7,
      maxOutputTokens: effectiveAiConfig.max_tokens || 500
    });
  } catch (err) {
    console.error('Gemini error:', err);
    return { error: 'AI service error', status: 500 };
  }

  // ============================================
  // STEP 11: Save AI response
  // ============================================
  if (currentSessionId && aiResponse) {
    await saveMessage(currentSessionId, 'assistant', aiResponse, 'ai');
    await updateSession(currentSessionId, {});
  }

  // ============================================
  // STEP 12: Run analysis (AWAIT to ensure completion)
  // ============================================
  if (currentSessionId && analysisConfig) {
    console.log('🔄 Starting analysis step...');
    
    const fullConversation = [
      ...(history || []),
      { role: 'user', content: prompt },
      { role: 'assistant', content: aiResponse }
    ];

    // AWAIT the analysis so it completes before function ends
    await runAnalysis(
      currentSessionId,
      customer,
      effectiveAiConfig,
      analysisConfig,
      actions,
      fullConversation,
      aiResponse,
      isTestMode
    );
  }

  // ============================================
  // STEP 13: Return response
  // ============================================
  return {
    response: aiResponse,
    sessionId: currentSessionId,
    customerId: customer.id,
    customerName: customer.name,
    aiName: effectiveAiConfig.ai_name,
    companion: companion || null,
    triggeredActions: triggeredActions.map(a => a.action_type),
    needsHandoff: false,
    suspicious: false,
    riskLevel: securityAnalysis.riskLevel
  };
}

// ============================================
// ANALYSIS (runs after AI response)
// ============================================
async function runAnalysis(sessionId, customer, aiConfig, analysisConfig, actions, conversation, aiResponse, isTestMode) {
  console.log('🔄 runAnalysis called');
  
  try {
    // Check if we should run analysis
    const { shouldRun, triggers } = shouldRunAnalysis(conversation, aiResponse, analysisConfig);

    console.log('🔍 Analysis triggers:', triggers);
    console.log('🔍 Should run:', shouldRun);

    if (!shouldRun) {
      console.log('ℹ️ No analysis triggers detected - skipping');
      return;
    }

    // Run Gemini analysis
    console.log('🧠 Calling Gemini for analysis...');
    const analysis = await analyzeConversation(conversation, aiConfig.ai_name);

    if (!analysis) {
      console.log('⚠️ Analysis returned null');
      return;
    }

    console.log('📊 Conversation analysis:', JSON.stringify(analysis));

    // Update session with guest info
    if (analysis.guest_name || analysis.guest_email || analysis.guest_phone) {
      console.log('📝 Updating session with guest info...');
      await updateSessionMetadata(sessionId, {
        guest_name: analysis.guest_name,
        guest_email: analysis.guest_email,
        guest_phone: analysis.guest_phone
      });
      console.log('✅ Session updated with guest info:', analysis.guest_name);
    }

    // Get fired triggers and execute actions
    const firedTriggers = getFiredTriggers(analysis);
    console.log('🎯 Fired triggers:', firedTriggers);

    if (firedTriggers.length === 0) {
      console.log('ℹ️ No triggers fired - skipping actions');
      return;
    }

    const context = {
      sessionId,
      customer,
      aiConfig,
      analysisConfig,
      analysis,
      isTestMode
    };

    for (const trigger of firedTriggers) {
      console.log(`⚙️ Executing actions for trigger: ${trigger}`);
      await executeActionsForTrigger(trigger, actions, context);
    }

    console.log('✅ Analysis complete');

  } catch (err) {
    console.error('❌ Analysis error:', err.message);
    console.error('❌ Stack:', err.stack);
  }
}
