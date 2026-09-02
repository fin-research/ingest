UPDATE policy_event
SET title = '828房地产政策',
    summary = '8月28日，多部门集中出台一揽子房地产政策，围绕加快构建房地产发展新模式，从房地产信贷管理、开发及相关融资管理、资本市场支持、商品住房销售制度等方面完善房地产开发、建设、销售和运营全生命周期制度，包括房地产信贷管理意见、五个房地产融资管理办法、资本市场支持意见、商品住房销售制度通知及配套答问。',
    category = 'real_estate',
    departments_json = '["中国人民银行","国家金融监督管理总局","中国证监会","住房城乡建设部","自然资源部"]',
    policy_date = '2026-08-28',
    first_news_at = (
      SELECT MIN(first_news_at)
      FROM policy_event
      WHERE id IN (
        '8590ad60-8f91-4d23-80cf-1dd546381d4a',
        '61aa0b38-da48-44f3-8f13-1d29348373dc',
        '7cb020f9-b090-423c-94c0-79fc10ded308',
        '8ebda125-14de-4641-a8ef-5179ecc61eb4',
        '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
      )
    ),
    last_news_at = (
      SELECT MAX(last_news_at)
      FROM policy_event
      WHERE id IN (
        '8590ad60-8f91-4d23-80cf-1dd546381d4a',
        '61aa0b38-da48-44f3-8f13-1d29348373dc',
        '7cb020f9-b090-423c-94c0-79fc10ded308',
        '8ebda125-14de-4641-a8ef-5179ecc61eb4',
        '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
      )
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '8590ad60-8f91-4d23-80cf-1dd546381d4a'
  AND 4 = (
    SELECT COUNT(*)
    FROM policy_event pe
    WHERE pe.id IN (
      '61aa0b38-da48-44f3-8f13-1d29348373dc',
      '7cb020f9-b090-423c-94c0-79fc10ded308',
      '8ebda125-14de-4641-a8ef-5179ecc61eb4',
      '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
    )
      AND NOT EXISTS (
        SELECT 1 FROM policy_article pa
        WHERE pa.policy_id = pe.id AND pa.association_method = 'manual'
      )
      AND NOT EXISTS (
        SELECT 1 FROM research_commentary rc WHERE rc.policy_id = pe.id
      )
  );

INSERT OR IGNORE INTO policy_article (
  policy_id, article_id, relation_status, association_method,
  confidence, rationale, created_at, updated_at
)
SELECT '8590ad60-8f91-4d23-80cf-1dd546381d4a', pa.article_id,
       pa.relation_status, pa.association_method, pa.confidence,
       pa.rationale, pa.created_at, pa.updated_at
FROM policy_article pa
WHERE pa.policy_id IN (
    '61aa0b38-da48-44f3-8f13-1d29348373dc',
    '7cb020f9-b090-423c-94c0-79fc10ded308',
    '8ebda125-14de-4641-a8ef-5179ecc61eb4',
    '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
  )
  AND pa.association_method = 'ai'
  AND 4 = (
    SELECT COUNT(*)
    FROM policy_event pe
    WHERE pe.id IN (
      '61aa0b38-da48-44f3-8f13-1d29348373dc',
      '7cb020f9-b090-423c-94c0-79fc10ded308',
      '8ebda125-14de-4641-a8ef-5179ecc61eb4',
      '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
    )
      AND NOT EXISTS (
        SELECT 1 FROM policy_article protected_pa
        WHERE protected_pa.policy_id = pe.id
          AND protected_pa.association_method = 'manual'
      )
      AND NOT EXISTS (
        SELECT 1 FROM research_commentary rc WHERE rc.policy_id = pe.id
      )
  );

DELETE FROM policy_article
WHERE policy_id IN (
    '61aa0b38-da48-44f3-8f13-1d29348373dc',
    '7cb020f9-b090-423c-94c0-79fc10ded308',
    '8ebda125-14de-4641-a8ef-5179ecc61eb4',
    '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
  )
  AND association_method = 'ai'
  AND 4 = (
    SELECT COUNT(*)
    FROM policy_event pe
    WHERE pe.id IN (
      '61aa0b38-da48-44f3-8f13-1d29348373dc',
      '7cb020f9-b090-423c-94c0-79fc10ded308',
      '8ebda125-14de-4641-a8ef-5179ecc61eb4',
      '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
    )
      AND NOT EXISTS (
        SELECT 1 FROM policy_article protected_pa
        WHERE protected_pa.policy_id = pe.id
          AND protected_pa.association_method = 'manual'
      )
      AND NOT EXISTS (
        SELECT 1 FROM research_commentary rc WHERE rc.policy_id = pe.id
      )
  );

UPDATE policy_news
SET policy_id = '8590ad60-8f91-4d23-80cf-1dd546381d4a',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE policy_id IN (
    '61aa0b38-da48-44f3-8f13-1d29348373dc',
    '7cb020f9-b090-423c-94c0-79fc10ded308',
    '8ebda125-14de-4641-a8ef-5179ecc61eb4',
    '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM policy_event pe
    WHERE pe.id IN (
      '61aa0b38-da48-44f3-8f13-1d29348373dc',
      '7cb020f9-b090-423c-94c0-79fc10ded308',
      '8ebda125-14de-4641-a8ef-5179ecc61eb4',
      '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
    )
      AND NOT EXISTS (
        SELECT 1 FROM policy_article pa
        WHERE pa.policy_id = pe.id AND pa.association_method = 'manual'
      )
      AND NOT EXISTS (
        SELECT 1 FROM research_commentary rc WHERE rc.policy_id = pe.id
      )
  );

DELETE FROM policy_event
WHERE id IN (
    '61aa0b38-da48-44f3-8f13-1d29348373dc',
    '7cb020f9-b090-423c-94c0-79fc10ded308',
    '8ebda125-14de-4641-a8ef-5179ecc61eb4',
    '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM policy_event pe
    WHERE pe.id IN (
      '61aa0b38-da48-44f3-8f13-1d29348373dc',
      '7cb020f9-b090-423c-94c0-79fc10ded308',
      '8ebda125-14de-4641-a8ef-5179ecc61eb4',
      '9d45aaba-f9b7-4e42-afc8-a98717df8abd'
    )
      AND NOT EXISTS (
        SELECT 1 FROM policy_article pa
        WHERE pa.policy_id = pe.id AND pa.association_method = 'manual'
      )
      AND NOT EXISTS (
        SELECT 1 FROM research_commentary rc WHERE rc.policy_id = pe.id
      )
  );
