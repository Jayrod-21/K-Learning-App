-- migrate: non-destructive
-- =============================================================================
-- Migration 067 — writing-prompt content depth (F-096)
--   UP — seeds 24 additional rubric-tagged TOPIK II writing prompts into
--        `writing_prompts` (12 × Q53, 12 × Q54), deepening the active bank
--        from ~3 prompts per rubric (the migration-038 seed) to 15 per
--        rubric so the server-side random draw (B-027,
--        GET /writing/prompts/random) has a real rotation instead of a
--        shallow 3-row loop.
--   Reverse: 067_writing_prompts_depth.down.sql (DELETEs exactly these 24
--        seed rows by source_id — declared destructive; see its own header).
--   Depends on: 013_writing_prompts (table), 038_writing_attempts (rubric
--        column + ck_writing_prompts_rubric CHECK + the wp-topik5x-0x
--        source_id naming convention this migration extends).
--
-- WHY: F-096 — "the active writing-prompt bank is only ~3 prompts/rubric
-- (migration 038 seed), so even with server-side random selection the
-- rotation is shallow." Pure add-only content work: INSERTs only, no schema
-- change, no UPDATE/DELETE of existing rows.
--
-- CONTENT CONTRACT (mirrors 038):
--   - rubric: 'topik_ii_53' (200~300자 expository/description task, exam
--     budget ~15 min) or 'topik_ii_54' (600~700자 argumentative essay,
--     ~30 min). NO free_write rows — free-write topics are Claude-GENERATED
--     on demand (POST /writing/generate, mode='general'), never bank rows;
--     `ck_writing_prompts_rubric` is deliberately narrow (see migration
--     056's header for the full rationale) and this migration keeps it so.
--   - level: Q53 spans L3/L4 (TOPIK 3–4 writing), Q54 spans L4/L5+ — a
--     spread, not a single band, so GET /plan/today's band-preference CASE
--     has real choices at every estimate.
--   - register: 문어체 (formal written style) — both rubrics are answered in
--     it, same as every 038 row.
--   - prompt_kr/prompt_en lengths sit far below the 1..2000 CHECK ceilings
--     (the longest here is ~230 chars; /grade-writing's zod edge mirrors
--     the same bound).
--   - source_id: continues 038's 'wp-topik53-NN' / 'wp-topik54-NN' sequence
--     (04–15). Idempotent via ON CONFLICT (source_id) DO NOTHING.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping write.
-- =============================================================================

INSERT INTO writing_prompts
    (source_id, title, prompt_kr, prompt_en, level, register, est_minutes, rubric)
VALUES
    -- ------------------------------------------------------------------
    -- TOPIK II 53번 — 200~300자 expository tasks (12 rows, L3/L4)
    -- ------------------------------------------------------------------
    ('wp-topik53-04',
     '규칙적인 운동의 좋은 점 — TOPIK II 53번',
     '규칙적인 운동이 우리의 몸과 마음에 주는 좋은 점에 대해 200~300자로 쓰십시오.',
     'Write 200-300 characters on the benefits regular exercise brings to our body and mind.',
     'L3', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-05',
     '스마트폰 사용의 장단점 — TOPIK II 53번',
     '스마트폰이 우리 생활에 주는 장점과 단점에 대해 200~300자로 쓰십시오.',
     'Write 200-300 characters on the advantages and disadvantages smartphones bring to our lives.',
     'L3', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-06',
     '혼자 하는 여행과 함께 하는 여행 — TOPIK II 53번',
     '혼자 하는 여행과 친구와 함께 하는 여행은 각각 어떤 좋은 점이 있습니까? 두 여행 방법의 좋은 점을 비교하여 200~300자로 쓰십시오.',
     'Compare the merits of traveling alone versus traveling with friends in 200-300 characters.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-07',
     '대중교통 이용의 장점 — TOPIK II 53번',
     '자가용 대신 버스나 지하철 같은 대중교통을 이용하면 어떤 점이 좋습니까? 대중교통 이용의 장점에 대해 200~300자로 쓰십시오.',
     'Write 200-300 characters on the advantages of using public transportation instead of a private car.',
     'L3', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-08',
     '외국어를 배우는 이유 — TOPIK II 53번',
     '사람들이 외국어를 배우는 이유는 무엇입니까? 외국어를 배우면 좋은 점과 함께 200~300자로 쓰십시오.',
     'Why do people learn foreign languages? Write 200-300 characters including the benefits of learning one.',
     'L3', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-09',
     '재택근무의 장단점 — TOPIK II 53번',
     '집에서 일하는 재택근무가 늘고 있습니다. 재택근무의 장점과 단점에 대해 200~300자로 쓰십시오.',
     'Working from home is on the rise. Write 200-300 characters on its advantages and disadvantages.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-10',
     '전통 시장과 대형 마트 — TOPIK II 53번',
     '전통 시장에서 장을 보는 것과 대형 마트에서 장을 보는 것은 각각 어떤 좋은 점이 있습니까? 두 곳의 좋은 점을 비교하여 200~300자로 쓰십시오.',
     'Compare the merits of shopping at a traditional market versus a large supermarket in 200-300 characters.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-11',
     '독서의 좋은 점 — TOPIK II 53번',
     '책을 많이 읽으면 어떤 점이 좋습니까? 독서가 우리에게 주는 좋은 점에 대해 200~300자로 쓰십시오.',
     'What are the benefits of reading many books? Write 200-300 characters on what reading gives us.',
     'L3', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-12',
     '배달 음식의 장단점 — TOPIK II 53번',
     '요즘 음식을 배달시켜 먹는 사람이 많아졌습니다. 배달 음식의 장점과 단점에 대해 200~300자로 쓰십시오.',
     'More people order food delivery these days. Write 200-300 characters on its advantages and disadvantages.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-13',
     '반려동물과 함께 사는 생활 — TOPIK II 53번',
     '반려동물을 기르는 사람이 많아지고 있습니다. 반려동물과 함께 살면 좋은 점과 힘든 점에 대해 200~300자로 쓰십시오.',
     'More people are keeping pets. Write 200-300 characters on the joys and difficulties of living with a pet.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-14',
     '계획적인 소비의 중요성 — TOPIK II 53번',
     '돈을 쓰기 전에 계획을 세우는 것은 왜 중요합니까? 계획적인 소비의 좋은 점에 대해 200~300자로 쓰십시오.',
     'Why is it important to plan before spending money? Write 200-300 characters on the benefits of planned spending.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-15',
     '좋아하는 계절 — TOPIK II 53번',
     '여러분이 가장 좋아하는 계절은 언제입니까? 그 계절의 특징과 좋아하는 이유를 200~300자로 쓰십시오.',
     'Which season do you like best? Describe its characteristics and your reasons in 200-300 characters.',
     'L3', '문어체', 15, 'topik_ii_53'),

    -- ------------------------------------------------------------------
    -- TOPIK II 54번 — 600~700자 argumentative essays (12 rows, L4/L5+)
    -- ------------------------------------------------------------------
    ('wp-topik54-04',
     '세대 갈등의 원인과 해결 — TOPIK II 54번',
     '현대 사회에서 세대 간의 갈등이 점점 심해지고 있습니다. 세대 갈등에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 세대 갈등이 생기는 원인은 무엇인가? 세대 갈등은 어떤 문제를 가져오는가? 세대 갈등을 해결하기 위해 어떤 노력이 필요한가?',
     'Generational conflict is deepening in modern society. Write a 600-700-character essay covering its causes, the problems it brings, and the efforts needed to resolve it.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-05',
     '조기 외국어 교육 — TOPIK II 54번',
     '어린 나이에 외국어 교육을 시작하는 것에 대해 찬성과 반대의 의견이 있습니다. 조기 외국어 교육에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 조기 외국어 교육의 장점은 무엇인가? 어떤 문제점이 있는가? 조기 외국어 교육에 찬성하는가, 반대하는가?',
     'Opinions are divided on starting foreign-language education at a young age. Write a 600-700-character essay on its advantages, its problems, and your own position.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-06',
     '소셜 미디어와 인간관계 — TOPIK II 54번',
     '소셜 미디어가 사람들의 인간관계에 미치는 영향에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 소셜 미디어가 인간관계에 주는 긍정적인 영향은 무엇인가? 부정적인 영향은 무엇인가? 소셜 미디어를 어떻게 사용해야 하는가?',
     'Write a 600-700-character essay on how social media affects human relationships: its positive effects, its negative effects, and how it should be used.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-07',
     '경쟁의 긍정적·부정적 측면 — TOPIK II 54번',
     '경쟁은 개인과 사회의 발전에 큰 영향을 미칩니다. 경쟁에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 경쟁의 긍정적인 측면은 무엇인가? 부정적인 측면은 무엇인가? 바람직한 경쟁이란 무엇인가?',
     'Competition strongly shapes personal and social development. Write a 600-700-character essay on its positive side, its negative side, and what desirable competition looks like.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-08',
     '저출산 문제 — TOPIK II 54번',
     '많은 나라에서 아이를 낳지 않는 저출산 문제가 심각해지고 있습니다. 저출산 문제에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 저출산의 원인은 무엇인가? 저출산은 사회에 어떤 영향을 미치는가? 이 문제를 해결하기 위해 어떤 노력이 필요한가?',
     'Falling birth rates are becoming a serious problem in many countries. Write a 600-700-character essay on the causes, the social impact, and the efforts needed to address it.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-09',
     '도시 집중 현상 — TOPIK II 54번',
     '인구와 일자리가 대도시로 집중되는 현상이 계속되고 있습니다. 도시 집중 현상에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 도시 집중의 원인은 무엇인가? 어떤 문제를 가져오는가? 이를 해결하기 위한 방법은 무엇인가?',
     'Population and jobs keep concentrating in big cities. Write a 600-700-character essay on the causes of urban concentration, the problems it creates, and possible solutions.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-10',
     '기술 발전과 일자리 — TOPIK II 54번',
     '기술이 발전하면서 사람의 일을 기계가 대신하는 경우가 많아지고 있습니다. 기술 발전이 일자리에 미치는 영향에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 기술 발전이 일자리에 주는 긍정적인 영향은 무엇인가? 부정적인 영향은 무엇인가? 우리는 어떻게 대비해야 하는가?',
     'Machines increasingly take over human work as technology advances. Write a 600-700-character essay on the positive and negative effects on jobs and how we should prepare.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-11',
     '대학 교육의 목적 — TOPIK II 54번',
     '대학 교육의 목적이 취업 준비인지 학문 탐구인지에 대해 의견이 나뉩니다. 대학 교육의 목적에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 대학 교육은 왜 필요한가? 취업 준비와 학문 탐구 중 무엇이 더 중요한가? 그렇게 생각하는 이유는 무엇인가?',
     'Opinions divide on whether university exists for job preparation or scholarly inquiry. Write a 600-700-character essay on why university education matters and which purpose you find more important.',
     'L4', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-12',
     '광고가 소비에 미치는 영향 — TOPIK II 54번',
     '광고는 사람들의 소비 생활에 큰 영향을 미칩니다. 광고에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 광고의 긍정적인 기능은 무엇인가? 부정적인 기능은 무엇인가? 소비자는 광고를 어떻게 받아들여야 하는가?',
     'Advertising strongly influences consumer behavior. Write a 600-700-character essay on its positive functions, its negative functions, and how consumers should receive it.',
     'L4', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-13',
     '칭찬의 교육적 효과 — TOPIK II 54번',
     '교육에서 칭찬은 중요한 역할을 합니다. 그러나 지나친 칭찬은 오히려 나쁜 영향을 줄 수도 있습니다. 칭찬에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 칭찬의 긍정적인 효과는 무엇인가? 지나친 칭찬은 어떤 문제를 가져오는가? 바람직한 칭찬의 방법은 무엇인가?',
     'Praise plays a key role in education, but excessive praise can backfire. Write a 600-700-character essay on its positive effects, the problems of over-praising, and how to praise well.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-14',
     '일과 삶의 균형 — TOPIK II 54번',
     '일과 개인 생활의 균형을 중요하게 생각하는 사람이 많아지고 있습니다. 일과 삶의 균형에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 일과 삶의 균형은 왜 중요한가? 균형이 깨지면 어떤 문제가 생기는가? 균형을 지키기 위해 어떤 노력이 필요한가?',
     'More people value work-life balance. Write a 600-700-character essay on why it matters, what happens when it breaks down, and what efforts are needed to keep it.',
     'L4', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-15',
     '환경 보호: 개인의 실천과 제도 — TOPIK II 54번',
     '환경 문제를 해결하기 위해서는 개인의 실천이 중요하다는 의견과 국가의 제도가 더 중요하다는 의견이 있습니다. 이에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 개인의 실천은 어떤 효과가 있는가? 제도적 노력은 왜 필요한가? 둘 중 무엇이 더 중요하다고 생각하는가?',
     'Some argue individual action matters most for the environment; others point to state policy. Write a 600-700-character essay weighing both and arguing which matters more.',
     'L5+', '문어체', 30, 'topik_ii_54')
ON CONFLICT (source_id) DO NOTHING;

-- End of 067_writing_prompts_depth.up.sql — runner owns the transaction (ADR-013).
