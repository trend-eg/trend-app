-- =====================================================================
--  بوابة مراجعة التصميمات · ترند
--  شغّل الملف ده كله مرة واحدة في Supabase › SQL Editor › New query › Run
--  وبعده شغّل سطر إنشاء الأدمن اللي في آخر الملف (بعد ما تعدّل الرقم والباسورد).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- الجداول ----------
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('admin','client')),
  client_id   uuid references public.clients(id) on delete cascade,
  name        text not null,
  phone       text not null unique,
  can_approve boolean not null default true,
  created_at  timestamptz not null default now(),
  check (role = 'admin' or client_id is not null)
);

create table if not exists public.months (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  label       text not null,              -- مثال: نوفمبر 2026
  period      date not null,              -- أول يوم في الشهر، للترتيب
  created_at  timestamptz not null default now()
);

create table if not exists public.designs (
  id          uuid primary key default gen_random_uuid(),
  month_id    uuid not null references public.months(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  title       text not null,
  caption     text not null default '',
  publish_on  date,
  sort        int  not null default 0,
  version     int  not null default 1,
  status      text not null default 'pending' check (status in ('pending','approved','changes')),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.design_images (
  id          uuid primary key default gen_random_uuid(),
  design_id   uuid not null references public.designs(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  version     int  not null,
  path        text not null,              -- <client_id>/<design_id>/v<n>-<i>.<ext>
  sort        int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  design_id   uuid not null references public.designs(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  version     int  not null,
  author_id   uuid references auth.users(id) on delete set null,
  author_name text not null default '',
  img_index   int,                         -- رقم الصورة في الكاروسيل (null = تعليق عام)
  x           real check (x between 0 and 100),
  y           real check (y between 0 and 100),
  category    text not null default 'other'
              check (category in ('text','colors','image','logo','caption','other')),
  body        text not null check (length(trim(body)) > 0),
  resolved    boolean not null default false,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

-- سجل ثابت لكل موافقة وطلب تعديل (إثبات بالتاريخ والوقت)
create table if not exists public.design_events (
  id          bigint generated always as identity primary key,
  design_id   uuid not null references public.designs(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  version     int  not null,
  action      text not null,               -- approved | changes | new_version
  user_id     uuid references auth.users(id) on delete set null,
  user_name   text not null default '',
  at          timestamptz not null default now()
);

create index if not exists months_client_idx   on public.months(client_id, period desc);
create index if not exists designs_month_idx   on public.designs(month_id, sort);
create index if not exists images_design_idx   on public.design_images(design_id, version, sort);
create index if not exists comments_design_idx on public.comments(design_id, created_at);
create index if not exists comments_open_idx   on public.comments(resolved) where not resolved;
create index if not exists events_design_idx   on public.design_events(design_id, at desc);

-- ---------- دوال مساعدة ----------
create or replace function public.phone_to_email(p_phone text)
returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
begin
  if d like '0020%' then d := substr(d, 3); end if;
  if d ~ '^01[0125]\d{8}$' then d := '2' || d; end if;
  if d !~ '^201[0125]\d{8}$' then
    raise exception 'رقم الموبايل غير صحيح: %', p_phone using errcode = '22023';
  end if;
  return d || '@clients.trend-eg.com';
end $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from public.profiles where id = auth.uid();
$$;

-- إنشاء مستخدم دخول (داخلي، مش متاح للمتصفح مباشرة)
create or replace function public._create_login(p_name text, p_phone text, p_password text,
                                                p_role text, p_client uuid, p_can_approve boolean)
returns uuid language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_uid   uuid := gen_random_uuid();
  v_email text := public.phone_to_email(p_phone);
begin
  if length(coalesce(p_password,'')) < 6 then
    raise exception 'الباسورد لازم يكون 6 حروف أو أرقام على الأقل' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'الرقم ده مسجل قبل كده' using errcode = '23505';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, email_change,
                          email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
          v_email, crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', jsonb_build_object('name', p_name),
          now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_uid, v_uid::text,
          jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());

  insert into public.profiles (id, role, client_id, name, phone, can_approve)
  values (v_uid, p_role, p_client, p_name, split_part(v_email, '@', 1), coalesce(p_can_approve, true));

  return v_uid;
end $$;

-- ---------- دوال الأدمن ----------
create or replace function public.admin_create_client(p_client_name text, p_contact_name text,
                                                      p_phone text, p_password text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_client uuid;
begin
  if not public.is_admin() then raise exception 'غير مسموح' using errcode = '42501'; end if;
  insert into public.clients (name) values (trim(p_client_name)) returning id into v_client;
  perform public._create_login(trim(p_contact_name), p_phone, p_password, 'client', v_client, true);
  return v_client;
end $$;

create or replace function public.admin_add_contact(p_client uuid, p_name text, p_phone text,
                                                    p_password text, p_can_approve boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'غير مسموح' using errcode = '42501'; end if;
  return public._create_login(trim(p_name), p_phone, p_password, 'client', p_client, p_can_approve);
end $$;

create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
begin
  if not public.is_admin() then raise exception 'غير مسموح' using errcode = '42501'; end if;
  if length(coalesce(p_password,'')) < 6 then
    raise exception 'الباسورد لازم يكون 6 حروف أو أرقام على الأقل' using errcode = '22023';
  end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now()
   where id = p_user;
end $$;

create or replace function public.admin_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'غير مسموح' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'مينفعش تمسح حسابك' using errcode = '22023'; end if;
  delete from auth.users where id = p_user;
end $$;

-- نسخة جديدة من التصميم بعد التعديل: الحالة ترجع "مستني مراجعة"
create or replace function public.admin_bump_version(p_design uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v int; c uuid;
begin
  if not public.is_admin() then raise exception 'غير مسموح' using errcode = '42501'; end if;
  update public.designs
     set version = version + 1, status = 'pending', reviewed_at = null, reviewed_by = null
   where id = p_design returning version, client_id into v, c;
  insert into public.design_events (design_id, client_id, version, action, user_id, user_name)
  values (p_design, c, v, 'new_version', auth.uid(),
          (select name from public.profiles where id = auth.uid()));
  return v;
end $$;

-- ---------- مراجعة العميل ----------
create or replace function public.client_review(p_design uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare d public.designs; p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  select * into d from public.designs where id = p_design;
  if d.id is null or p.id is null or (p.role <> 'admin' and d.client_id is distinct from p.client_id) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if p_status not in ('approved','changes') then
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;
  if p_status = 'approved' and not p.can_approve then
    raise exception 'الموافقة النهائية من صلاحية شخص تاني في حسابكم' using errcode = '42501';
  end if;
  update public.designs set status = p_status, reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_design;
  insert into public.design_events (design_id, client_id, version, action, user_id, user_name)
  values (d.id, d.client_id, d.version, p_status, auth.uid(), p.name);
end $$;

-- اسم كاتب التعليق بيتاخد من حسابه، مش من اللي بيتبعت من المتصفح
create or replace function public._comment_author()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.author_id   := auth.uid();
  new.author_name := coalesce((select name from public.profiles where id = auth.uid()), '');
  if tg_op = 'INSERT' then new.created_at := now(); end if;
  return new;
end $$;
drop trigger if exists comments_author on public.comments;
create trigger comments_author before insert on public.comments
  for each row execute function public._comment_author();

-- ---------- الصلاحيات (Row Level Security) ----------
alter table public.clients       enable row level security;
alter table public.profiles      enable row level security;
alter table public.months        enable row level security;
alter table public.designs       enable row level security;
alter table public.design_images enable row level security;
alter table public.comments      enable row level security;
alter table public.design_events enable row level security;

do $$
declare t text;
begin
  -- امسح أي سياسات قديمة عشان الملف يتشغل أكتر من مرة من غير مشاكل
  for t in select format('drop policy if exists %I on %I.%I', policyname, schemaname, tablename)
             from pg_policies where schemaname = 'public'
              and tablename in ('clients','profiles','months','designs','design_images','comments','design_events')
  loop execute t; end loop;
end $$;

create policy clients_read  on public.clients for select to authenticated
  using (public.is_admin() or id = public.my_client_id());
create policy clients_admin on public.clients for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy profiles_read on public.profiles for select to authenticated
  using (public.is_admin() or id = auth.uid() or client_id = public.my_client_id());
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy months_read  on public.months for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());
create policy months_admin on public.months for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy designs_read  on public.designs for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());
create policy designs_admin on public.designs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy images_read  on public.design_images for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());
create policy images_admin on public.design_images for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy comments_read on public.comments for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());
create policy comments_insert on public.comments for insert to authenticated
  with check (
    author_id = auth.uid() and resolved = false and
    exists (select 1 from public.designs d
             where d.id = design_id and d.client_id = comments.client_id and d.version = comments.version
               and (public.is_admin() or d.client_id = public.my_client_id()))
  );
create policy comments_admin_update on public.comments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy comments_delete on public.comments for delete to authenticated
  using (public.is_admin() or (author_id = auth.uid() and not resolved));

create policy events_read on public.design_events for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());

-- الدوال الداخلية مش متاحة لحد من برّه
revoke all on function public._create_login(text,text,text,text,uuid,boolean) from public, anon, authenticated;
revoke all on function public.admin_create_client(text,text,text,text) from public, anon;
revoke all on function public.admin_add_contact(uuid,text,text,text,boolean) from public, anon;
revoke all on function public.admin_set_password(uuid,text) from public, anon;
revoke all on function public.admin_delete_user(uuid) from public, anon;
revoke all on function public.admin_bump_version(uuid) from public, anon;
revoke all on function public.client_review(uuid,text) from public, anon;
grant execute on function public.admin_create_client(text,text,text,text) to authenticated;
grant execute on function public.admin_add_contact(uuid,text,text,text,boolean) to authenticated;
grant execute on function public.admin_set_password(uuid,text) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
grant execute on function public.admin_bump_version(uuid) to authenticated;
grant execute on function public.client_review(uuid,text) to authenticated;

-- ---------- تخزين الصور (خاص، بلينكات مؤقتة) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('designs', 'designs', false, 20971520,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = false;

drop policy if exists designs_files_read  on storage.objects;
drop policy if exists designs_files_admin on storage.objects;
create policy designs_files_read on storage.objects for select to authenticated
  using (bucket_id = 'designs' and
         (public.is_admin() or (storage.foldername(name))[1] = public.my_client_id()::text));
create policy designs_files_admin on storage.objects for all to authenticated
  using (bucket_id = 'designs' and public.is_admin())
  with check (bucket_id = 'designs' and public.is_admin());

-- =====================================================================
--  إنشاء حساب الأدمن (إنت) — عدّل الاسم والرقم والباسورد وشغّل السطر ده لوحده:
--
--  select public._create_login('ترند', '01000000000', 'غير-الباسورد-ده', 'admin', null, true);
-- =====================================================================
