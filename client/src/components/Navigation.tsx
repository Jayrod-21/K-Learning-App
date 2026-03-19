/**
 * Navigation Component
 * Persistent sidebar/top nav for navigating between modules.
 */
import { Link, useLocation } from 'react-router-dom';

interface NavItem {
  path: string;
  label: string;
  labelKorean: string;
  icon: string;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', labelKorean: '대시보드', icon: '🏠' },
  { path: '/curriculum', label: 'Curriculum', labelKorean: '교육과정', icon: '📋' },
  { path: '/vocab', label: 'Vocabulary', labelKorean: '단어', icon: '📚' },
  { path: '/grammar', label: 'Grammar', labelKorean: '문법', icon: '✏️' },
  { path: '/topik', label: 'TOPIK Prep', labelKorean: 'TOPIK 연습', icon: '📝' },
  { path: '/conversation', label: 'Conversation', labelKorean: 'AI 대화', icon: '💬' },
  { path: '/reading', label: 'Reading', labelKorean: '읽기', icon: '📖' },
];

export default function Navigation() {
  const location = useLocation();

  return (
    <nav className="bg-[#12121f] border-b border-[#2a2a3e] px-4 py-2">
      <div className="max-w-7xl mx-auto flex items-center gap-1 overflow-x-auto">
        <Link to="/" className="text-[#C9A84C] font-bold text-lg mr-4 whitespace-nowrap font-['Noto_Sans_KR']">
          한국어 마스터
        </Link>
        {navItems.map((item) => {
          const isActive = location.pathname === item.path ||
            (item.path !== '/' && location.pathname.startsWith(item.path));
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-[#8B1A1A] text-[#F5F0E8]'
                  : 'text-[#a0a0b0] hover:bg-[#1f1f32] hover:text-[#F5F0E8]'
              }`}
            >
              <span>{item.icon}</span>
              <span className="hidden md:inline">{item.label}</span>
              <span className="md:hidden font-['Noto_Sans_KR']">{item.labelKorean}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
