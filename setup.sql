-- ФИНАЛЬНЫЙ SQL-СКРИПТ (КОПИРОВАТЬ ЦЕЛИКОМ И НАЖАТЬ RUN)

-- 1. Таблица профилей (создаем если нет, или дополняем)
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  email text,
  name text,
  surname text,
  organization text,
  position text,
  phone text,
  region text,
  inn text,
  verified boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- 2. Таблица уведомлений (ОБЯЗАТЕЛЬНО НУЖНА ДЛЯ РАБОТЫ)
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  text text not null,
  read boolean default false,
  time timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

-- 3. Включение безопасности (RLS)
alter table public.profiles enable row level security;
alter table public.notifications enable row level security;

-- Пытаемся создать политики, игнорируя если они уже есть
do $$
begin
    -- Профили
    if not exists (select 1 from pg_policies where policyname = 'Users can view own profile') then
        create policy "Users can view own profile" on public.profiles for select using (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'Users can update own profile') then
        create policy "Users can update own profile" on public.profiles for update using (auth.uid() = user_id);
    end if;
    
    -- Уведомления
    if not exists (select 1 from pg_policies where policyname = 'Users can view own notifications') then
        create policy "Users can view own notifications" on public.notifications for select using (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'Users can update own notifications') then
        create policy "Users can update own notifications" on public.notifications for update using (auth.uid() = user_id);
    end if;
end $$;

-- 4. Функция авто-профиля (если еще нет)
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (user_id, email, name, surname)
  values (new.id, new.email, new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'surname')
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$ language plpgsql security definer;

-- 5. Индексы
create index if not exists idx_profiles_user_id on public.profiles(user_id);
create index if not exists idx_notifications_user_id on public.notifications(user_id);
