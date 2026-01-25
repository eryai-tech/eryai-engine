export async function getCompanion(customerId, companionKey) {
  console.log(`🔍 getCompanion called: customerId=${customerId}, companionKey=${companionKey}`);
  
  const { data, error } = await getSupabase()
    .from('customer_companions')
    .select('*')
    .eq('customer_id', customerId)
    .eq('companion_key', companionKey)
    .eq('is_active', true)
    .single();
  
  if (error) {
    console.error('❌ getCompanion error:', error.message, error.code);
  }
  
  console.log(`🔍 getCompanion result:`, data ? data.ai_name : 'null');
  return data;
}
