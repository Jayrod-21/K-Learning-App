/**
 * AI Conversation Partner Page
 * Chat interface for practicing Korean with Claude API.
 * Falls back to a practice mode when API is not configured.
 */
import { useState, useRef, useEffect } from 'react';
import api from '../services/api';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

type ConversationMode = 'casual' | 'business' | 'topik_prep';

const MODE_CONFIG: Record<ConversationMode, { label: string; labelKr: string; description: string; icon: string }> = {
  casual: { label: 'Casual', labelKr: '일상 대화', description: 'Everyday Korean conversation practice', icon: '😄' },
  business: { label: 'Business', labelKr: '비즈니스', description: 'Formal business Korean practice', icon: '🏢' },
  topik_prep: { label: 'TOPIK Prep', labelKr: 'TOPIK 준비', description: 'TOPIK exam-style conversation', icon: '📝' },
};

const STARTER_PROMPTS: Record<ConversationMode, string[]> = {
  casual: [
    '안녕하세요! 오늘 뭐 했어요?',
    '좋아하는 한국 음식이 뭐예요?',
    '주말에 보통 뭐 해요?',
    '한국에 가 본 적 있어요?',
  ],
  business: [
    '회의 시간을 정하고 싶습니다.',
    '이메일로 보고서를 보내 드리겠습니다.',
    '프로젝트 진행 상황을 말씀드리겠습니다.',
    '출장 일정을 확인하고 싶습니다.',
  ],
  topik_prep: [
    '환경 문제에 대해 어떻게 생각하세요?',
    '한국의 교육 시스템에 대해 설명해 주세요.',
    '인터넷의 장단점은 무엇입니까?',
    '건강한 생활 습관에 대해 이야기해 봅시다.',
  ],
};

export default function Conversation() {
  const [mode, setMode] = useState<ConversationMode>('casual');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /** Send message to AI backend */
  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMessage: Message = { role: 'user', content: input.trim(), timestamp: new Date() };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const response = await api.post('/conversation', {
        messages: [...messages, userMessage].map((m) => ({ role: m.role, content: m.content })),
        mode,
      });

      const aiMessage: Message = {
        role: 'assistant',
        content: response.data.response,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, aiMessage]);
    } catch (err) {
      setError('AI service unavailable. Make sure the server is running and ANTHROPIC_API_KEY is set.');
      const fallbackMessage: Message = {
        role: 'assistant',
        content: getFallbackResponse(input.trim(), mode),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, fallbackMessage]);
    } finally {
      setLoading(false);
    }
  }

  /** Start a new conversation */
  function resetConversation() {
    setMessages([]);
    setError('');
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 flex flex-col h-[calc(100vh-120px)]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR']">AI 대화 연습</h1>
          <p className="text-[#a0a0b0] text-sm">Practice Korean conversation with AI</p>
        </div>
        <button
          onClick={resetConversation}
          className="bg-[#1f1f32] text-[#a0a0b0] px-4 py-2 rounded-lg text-sm hover:text-white transition-colors"
        >
          New Chat
        </button>
      </div>

      {/* Mode selector */}
      <div className="flex gap-2 mb-4">
        {(Object.entries(MODE_CONFIG) as [ConversationMode, typeof MODE_CONFIG.casual][]).map(([key, config]) => (
          <button
            key={key}
            onClick={() => { setMode(key); resetConversation(); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
              mode === key ? 'bg-[#8B1A1A] text-white' : 'bg-[#1f1f32] text-[#a0a0b0] hover:text-white'
            }`}
          >
            <span>{config.icon}</span>
            <span>{config.label}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 mb-4 text-yellow-300 text-sm">
          {error}
        </div>
      )}

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto bg-[#12121f] rounded-lg border border-[#2a2a3e] p-4 mb-4">
        {messages.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-[#a0a0b0] mb-4">{MODE_CONFIG[mode].description}</p>
            <p className="text-[#a0a0b0] text-sm mb-6">Try one of these starters:</p>
            <div className="space-y-2 max-w-md mx-auto">
              {STARTER_PROMPTS[mode].map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => setInput(prompt)}
                  className="w-full text-left bg-[#1f1f32] rounded-lg p-3 text-[#F5F0E8] font-['Noto_Sans_KR']
                             hover:bg-[#252540] transition-colors text-sm"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-lg p-4 ${
                    msg.role === 'user'
                      ? 'bg-[#8B1A1A] text-white'
                      : 'bg-[#1f1f32] text-[#F5F0E8] border border-[#2a2a3e]'
                  }`}
                >
                  <p className="font-['Noto_Sans_KR'] whitespace-pre-wrap">{msg.content}</p>
                  <span className="text-xs opacity-50 mt-1 block">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-[#1f1f32] border border-[#2a2a3e] rounded-lg p-4">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-[#C9A84C] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 bg-[#C9A84C] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 bg-[#C9A84C] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="한국어로 메시지를 입력하세요... (Type in Korean)"
          className="flex-1 bg-[#1f1f32] border border-[#2a2a3e] rounded-lg px-4 py-3
                     text-[#F5F0E8] font-['Noto_Sans_KR'] focus:border-[#C9A84C] focus:outline-none"
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || loading}
          className="bg-[#8B1A1A] text-white px-6 py-3 rounded-lg font-semibold
                     hover:bg-[#a02020] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * Simple fallback responses when AI backend is unavailable.
 * Provides basic practice even without the Claude API.
 */
function getFallbackResponse(input: string, mode: ConversationMode): string {
  const responses: Record<ConversationMode, string[]> = {
    casual: [
      '좋아요! 그런데 API 연결이 안 되어 있어서 자세한 대화가 어려워요. 서버를 확인해 주세요.\n\n(The AI server is not connected. Please check your server configuration and ANTHROPIC_API_KEY.)',
      '네, 알겠어요! AI 서버가 연결되면 더 자세한 대화를 할 수 있어요.\n\n(Connect the AI server for full conversation practice.)',
    ],
    business: [
      '네, 말씀 감사합니다. 현재 AI 서비스가 연결되지 않은 상태입니다. 서버 설정을 확인해 주시기 바랍니다.\n\n(AI service is not connected. Please verify server settings.)',
    ],
    topik_prep: [
      '좋은 주제입니다. 하지만 현재 AI 엔진이 연결되어 있지 않습니다. 서버를 확인하시기 바랍니다.\n\n(AI engine not connected. Please check your server.)',
    ],
  };
  const options = responses[mode];
  return options[Math.floor(Math.random() * options.length)];
}
