-- Behaviour check for supabase/v14_followups.sql. NOT a migration: run it only against a scratch
-- database that has every migration applied (setup.sql … v13, then v14), never against production.
-- It runs in one transaction and rolls back. Every check is an ASSERT: any failure aborts with its message.
--
--   psql -v ON_ERROR_STOP=1 -d <scratch db> -f supabase/checks/v14_followups_check.sql
--
-- (A scratch Postgres needs the Supabase roles first: create role anon; create role authenticated;
-- create role service_role bypassrls;)

begin;

insert into public.businesses (id, name, town, trade) values
  ('a0000000-0000-4000-8000-000000000001', 'Bluebird Wash & Fold', 'Seaford', 'laundromat'),
  ('a0000000-0000-4000-8000-000000000002', 'Harbor Plumbing', 'Hicksville', 'plumber'),
  ('a0000000-0000-4000-8000-000000000003', 'Paid Co', 'Bethpage', 'plumber'),
  ('a0000000-0000-4000-8000-000000000004', 'Test Paid Co', 'Bethpage', 'plumber'),
  ('a0000000-0000-4000-8000-000000000005', 'Email Paid Co', 'Bethpage', 'plumber'),
  ('a0000000-0000-4000-8000-000000000006', 'Unsub Co', 'Bethpage', 'plumber');

insert into public.email_events (business_id, arm, campaign, token, event, email, town, report_token, occurred_at, sent_at) values
  ('a0000000-0000-4000-8000-000000000001', 'email', 'exp002', 'Root_one_abcdefghijk', 'sent', 'owner@bluebird.example', 'Seaford', 'rep_one', now() - interval '10 days', now() - interval '10 days'),
  ('a0000000-0000-4000-8000-000000000002', 'email', 'exp002', 'Root_two_abcdefghijk', 'sent', 'owner@harbor.example', 'Hicksville', 'rep_two', now() - interval '10 days', now() - interval '10 days'),
  ('a0000000-0000-4000-8000-000000000003', 'email', 'exp002', 'Root_paid_abcdefghij', 'sent', 'owner@paid.example', 'Bethpage', 'rep_paid', now() - interval '10 days', now() - interval '10 days'),
  ('a0000000-0000-4000-8000-000000000004', 'email', 'exp002', 'Root_test_abcdefghij', 'sent', 'owner@testpaid.example', 'Bethpage', null, now() - interval '10 days', now() - interval '10 days'),
  ('a0000000-0000-4000-8000-000000000005', 'email', 'exp002', 'Root_mail_abcdefghij', 'sent', 'owner@emailpaid.example', 'Bethpage', null, now() - interval '10 days', now() - interval '10 days'),
  ('a0000000-0000-4000-8000-000000000006', 'email', 'exp002', 'Root_unsb_abcdefghij', 'sent', 'owner@unsub.example', 'Bethpage', 'rep_unsb', now() - interval '10 days', now() - interval '10 days');

-- Purchases: a live payment on the business, a TEST payment (still counts: fail closed), and a payment
-- matched only by the prospect's email address. An unsubscribe by address.
insert into public.payments (business_id, tier, amount_cents, livemode) values ('a0000000-0000-4000-8000-000000000003', 'xray', 4900, true);
insert into public.payments (business_id, tier, amount_cents, livemode) values ('a0000000-0000-4000-8000-000000000004', 'xray', 4900, false);
insert into public.payments (tier, amount_cents, livemode, customer_email) values ('xray', 4900, true, 'Owner@EmailPaid.example');
insert into public.unsubscribes (email) values ('OWNER@unsub.example');

do $$
declare
  r jsonb;
  c record;
  n int;
begin
  -- ---- the claim: stages, the max-2 cap, token linkage ------------------------------------------
  r := public.claim_followup_send('Root_one_abcdefghijk', 'bump', 'Fu_bump_abcdefghijkl');
  assert (r->>'ok')::boolean, 'bump claim: ' || r::text;
  r := public.claim_followup_send('Root_one_abcdefghijk', 'bump', 'Fu_bump2_abcdefghijk');
  assert r->>'reason' = 'already', 'same stage twice: ' || r::text;
  r := public.claim_followup_send('Root_one_abcdefghijk', 'followup1', 'Fu_one_abcdefghijklm');
  assert (r->>'ok')::boolean and (r->>'followups')::int = 2, 'second follow-up: ' || r::text;
  r := public.claim_followup_send('Root_one_abcdefghijk', 'followup2', 'Fu_two_abcdefghijklm');
  assert r->>'reason' = 'max', 'a third follow-up is refused: ' || r::text;
  select count(*) into n from public.email_events where parent_token = 'Root_one_abcdefghijk' and event = 'sent';
  assert n = 2, 'exactly 2 follow-up rows, got ' || n;

  -- The follow-up row copies the prospect and links back to it.
  select * into c from public.email_events where token = 'Fu_one_abcdefghijklm' and event = 'sent';
  assert c.parent_token = 'Root_one_abcdefghijk' and c.followup_stage = 'followup1', 'linked to the prospect';
  assert c.business_id = 'a0000000-0000-4000-8000-000000000001' and c.campaign = 'exp002' and c.email = 'owner@bluebird.example'
     and c.report_token = 'rep_one' and c.arm = 'email', 'copies business, campaign, email, report';

  -- Events on a follow-up token carry the link too (the pixel / click / unsubscribe RPC).
  assert public.log_email_event('Fu_one_abcdefghijklm', 'clicked', '/report/rep_one', 'Mozilla'), 'click logged';
  select * into c from public.email_events where token = 'Fu_one_abcdefghijklm' and event = 'clicked';
  assert c.parent_token = 'Root_one_abcdefghijk' and c.followup_stage = 'followup1' and c.campaign = 'exp002', 'click row linked';

  -- Bad input.
  assert public.claim_followup_send('Root_two_abcdefghijk', 'followup9', 'Fu_x_abcdefghijklmno')->>'reason' = 'bad stage', 'bad stage';
  assert public.claim_followup_send('Root_two_abcdefghijk', 'bump', 'short')->>'reason' = 'bad token', 'bad token';
  assert public.claim_followup_send('Root_two_abcdefghijk', 'bump', 'Root_two_abcdefghijk')->>'reason' = 'bad token', 'own token';
  assert public.claim_followup_send('Nobody_abcdefghijklm', 'bump', 'Fu_x_abcdefghijklmno')->>'reason' = 'unknown prospect', 'unknown';
  -- A follow-up token is not a prospect: no follow-ups of follow-ups.
  assert public.claim_followup_send('Fu_one_abcdefghijklm', 'bump', 'Fu_y_abcdefghijklmno')->>'reason' = 'unknown prospect', 'no chains of chains';

  -- ---- suppression, fail closed ------------------------------------------------------------------
  assert public.claim_followup_send('Root_paid_abcdefghij', 'bump', 'Fu_p_abcdefghijklmno')->>'reason' = 'purchased', 'paid on the business';
  assert public.claim_followup_send('Root_test_abcdefghij', 'bump', 'Fu_t_abcdefghijklmno')->>'reason' = 'purchased', 'a test payment counts too';
  assert public.claim_followup_send('Root_mail_abcdefghij', 'bump', 'Fu_m_abcdefghijklmno')->>'reason' = 'purchased', 'paid under their email';
  assert public.claim_followup_send('Root_unsb_abcdefghij', 'bump', 'Fu_u_abcdefghijklmno')->>'reason' = 'unsubscribed', 'unsubscribed by address';

  -- A payment on a report their click asked for (report_requests.ref_token = a follow-up's token).
  r := public.claim_followup_send('Root_two_abcdefghijk', 'bump', 'Fu_harb_abcdefghijkl');
  assert (r->>'ok')::boolean, 'Harbor bump: ' || r::text;
  insert into public.report_requests (business_name, town, email, ref_token, report_token) values ('Harbor Plumbing', 'Hicksville', 'x@y.example', 'Fu_harb_abcdefghijkl', 'rep_new');
  assert not public.followup_purchased('Root_two_abcdefghijk'), 'not bought yet';
  insert into public.payments (report_token, tier, amount_cents, livemode) values ('rep_new', 'xray', 4900, true);
  assert public.followup_purchased('Root_two_abcdefghijk'), 'bought through the follow-up''s report';
  assert public.claim_followup_send('Root_two_abcdefghijk', 'followup1', 'Fu_h1_abcdefghijklmn')->>'reason' = 'purchased', 'no follow-up after buying';

  -- Unsubscribed through a follow-up's own link.
  assert public.log_email_event('Fu_bump_abcdefghijkl', 'unsubscribed', null, 'Mozilla'), 'unsubscribe logged';
  assert exists (select 1 from public.unsubscribes where email = 'owner@bluebird.example'), 'suppression row written';

  -- ---- release: only a claim nothing has happened on --------------------------------------------
  insert into public.email_events (business_id, arm, campaign, token, event, email, report_token, occurred_at)
  values ('a0000000-0000-4000-8000-000000000002', 'email', 'exp002b', 'Root_rel_abcdefghijk', 'sent', 'rel@x.example', 'rep_rel', now() - interval '6 days');
  assert (public.claim_followup_send('Root_rel_abcdefghijk', 'bump', 'Fu_rel_abcdefghijklm')->>'ok')::boolean, 'rel claim';
  assert public.release_followup_send('Fu_rel_abcdefghijklm'), 'released';
  assert not exists (select 1 from public.email_events where token = 'Fu_rel_abcdefghijklm'), 'row gone';
  assert (public.claim_followup_send('Root_rel_abcdefghijk', 'bump', 'Fu_rel2_abcdefghijkl')->>'ok')::boolean, 'claimable again';
  perform public.log_email_event('Fu_rel2_abcdefghijkl', 'opened', null, null);
  assert not public.release_followup_send('Fu_rel2_abcdefghijkl'), 'not released once it has events';
  assert not public.release_followup_send('Root_rel_abcdefghijk'), 'a first email is never released';

  -- ---- mark replied ------------------------------------------------------------------------------
  assert public.mark_email_replied('Root_rel_abcdefghijk'), 'marked';
  assert (select replied_at is not null from public.email_events where token = 'Root_rel_abcdefghijk' and event = 'sent'), 'root replied';
  assert (select replied_at is not null from public.email_events where token = 'Fu_rel2_abcdefghijkl' and event = 'sent'), 'latest follow-up replied';
  assert public.claim_followup_send('Root_rel_abcdefghijk', 'followup1', 'Fu_rel3_abcdefghijkl')->>'reason' = 'replied', 'no follow-up after a reply';
  assert not public.mark_email_replied('Fu_rel2_abcdefghijkl'), 'only prospects (first emails) are marked';

  -- ---- one first email per business + campaign; follow-ups share it --------------------------------
  begin
    insert into public.email_events (business_id, arm, campaign, token, event) values ('a0000000-0000-4000-8000-000000000001', 'email', 'EXP002', 'Dup_root_abcdefghijk', 'sent');
    assert false, 'a second first email for the same business + campaign must fail';
  exception when unique_violation then null;
  end;
  begin
    insert into public.email_events (business_id, arm, campaign, token, event, parent_token, followup_stage) values ('a0000000-0000-4000-8000-000000000001', 'email', 'exp002', 'Fu_dup_abcdefghijklm', 'sent', 'Root_one_abcdefghijk', 'bump');
    assert false, 'the same stage twice must fail at the index too';
  exception when unique_violation then null;
  end;
  begin
    insert into public.email_events (token, event, followup_stage) values ('Fu_nop_abcdefghijklm', 'sent', 'bump');
    assert false, 'a stage without a parent must fail the check';
  exception when check_violation then null;
  end;
end $$;

-- ---- views ------------------------------------------------------------------------------------------
do $$
declare
  c record;
  f record;
begin
  select * into c from public.v_followup_candidates where token = 'Root_one_abcdefghijk';
  assert c.business = 'Bluebird Wash & Fold' and c.trade = 'laundromat' and c.town = 'Seaford', 'business details';
  assert c.clicked_at is not null, 'a click on a follow-up counts for the prospect';
  assert c.unsubscribed_at is not null, 'an unsubscribe on a follow-up counts for the prospect';
  assert jsonb_array_length(c.followups) = 2, 'two follow-ups listed';
  assert c.followups->0->>'stage' = 'bump' and c.followups->1->>'stage' = 'followup1', 'in order';
  assert c.purchased = false, 'not bought';
  assert not exists (select 1 from public.v_followup_candidates where token like 'Fu\_%'), 'follow-ups are not candidates';
  select purchased into c from public.v_followup_candidates where token = 'Root_test_abcdefghij';
  assert c.purchased, 'test payment → purchased';
  -- An event row without the link (as the v12 log_email_event wrote it) still counts for the prospect.
  select clicked_at into c from public.v_followup_candidates where token = 'Root_rel_abcdefghijk';
  assert c.clicked_at is null, 'no click yet';
  insert into public.email_events (business_id, arm, campaign, token, event) values ('a0000000-0000-4000-8000-000000000002', 'email', 'exp002b', 'Fu_rel2_abcdefghijkl', 'clicked');
  select clicked_at into c from public.v_followup_candidates where token = 'Root_rel_abcdefghijk';
  assert c.clicked_at is not null, 'an unlinked click on a follow-up still counts';

  -- A claimed follow-up that never went out is left out of the stage funnel.
  update public.email_events set detail = 'not sent: Gmail 500' where token = 'Fu_one_abcdefghijklm' and event = 'sent';
  select * into f from public.v_followup_funnel where campaign = 'exp002' and followup_stage = 'followup1';
  assert f is null or f.sent = 0, 'not-sent follow-up excluded';
  update public.email_events set detail = null where token = 'Fu_one_abcdefghijklm' and event = 'sent';
  select * into f from public.v_followup_funnel where campaign = 'exp002' and followup_stage = 'followup1';
  assert f.sent = 1 and f.clicked = 1, 'follow-up 1: sent 1, clicked 1 (' || row_to_json(f)::text || ')';
  select * into f from public.v_followup_funnel where campaign = 'exp002' and followup_stage = 'initial';
  assert f.sent = 6, 'six first emails in exp002, got ' || f.sent;
  select * into f from public.v_followup_funnel where campaign = 'exp002' and followup_stage = 'bump';
  assert f.sent = 2 and f.unsubscribed = 1, 'two bumps, one unsubscribed (' || row_to_json(f)::text || ')';
  select * into f from public.v_followup_funnel where campaign = 'exp002b' and followup_stage = 'bump';
  assert f.opened = 1 and f.replied = 1, 'exp002b bump: opened, replied (' || row_to_json(f)::text || ')';

  -- First-email numbers are unchanged by follow-ups.
  select * into f from public.v_email_funnel where arm = 'email';
  assert f.sent = 7, 'v_email_funnel counts first emails only, got ' || f.sent;
  select actual, detail into f from public.v_mvp_gates where gate = 'email_reply_rate';
  assert f.detail = '1 replies to 7 emails', 'gates count first emails only: ' || f.detail;
  -- The timeline has the reply.
  assert exists (select 1 from public.v_email_timeline where token = 'Root_rel_abcdefghijk' and kind = 'replied'), 'replied on the timeline';
end $$;

-- ---- nothing public can call the new RPCs or read the new tables ---------------------------------
set local role anon;
do $$ begin
  begin perform public.claim_followup_send('Root_two_abcdefghijk', 'followup1', 'Fu_anon_abcdefghijk');
    assert false, 'anon must not claim';
  exception when insufficient_privilege then null; end;
  begin perform public.mark_email_replied('Root_two_abcdefghijk');
    assert false, 'anon must not mark replied';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.outreach_templates;
    assert false, 'anon must not read templates';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.v_followup_candidates;
    assert false, 'anon must not read candidates';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'v14 follow-up checks: all passed' as result;
rollback;
