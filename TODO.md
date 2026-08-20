# TODO: Chat Page Redesign

## Overview
Redesign the OcuGuide chat interface to behave like modern LLM chatbots with natural conversational flow, optional tool usage, and enhanced visual design.

---

## 1. Conversational Response Enhancement

### 1.1 Text-First Response Model
- [ ] Enable chatbot to respond with plain text answers for basic questions
- [ ] Make tool execution (graphs/data tables) optional, not mandatory
- [ ] Only invoke tools when data visualization or specific facility information is necessary
- [ ] Allow chatbot to answer general questions about AC management, energy efficiency, best practices without tools

### 1.2 Mixed Content Responses
- [ ] Support responses that combine text explanations with graphs/charts
- [ ] Display graphs inline within the chat conversation flow
- [ ] Ensure text accompanies visualizations to provide context and insights
- [ ] Format responses like modern LLMs (ChatGPT, Claude, etc.) with text + optional visualizations

---

## 2. Chat Interface Restructuring

### 2.1 Merge Two-Panel Layout into Single Chat Flow
- [ ] Remove the separate "Chat" and "Report" panel design
- [ ] Eliminate the two-bubble/two-panel workspace (conversation panel + report panel)
- [ ] Consolidate into one unified, scrollable chat interface
- [ ] Remove mobile tab switching between "Chat" and "Report"
- [ ] Keep one input bar at the bottom (already exists, no duplication issue)

### 2.2 Unified Chat Display
- [ ] Create single scrollable chat thread that contains all messages AND their associated data
- [ ] Display both text responses and graphs/charts inline within the same message bubble
- [ ] When assistant responds, show text explanation followed immediately by relevant graphs/charts in the same response
- [ ] Structure like modern LLMs: User message → Assistant text + inline visualizations → User message → etc.
- [ ] Ensure consistent message formatting for user and assistant messages
- [ ] Add proper spacing and visual separation between messages
- [ ] Remove the need to click "Show Report" or switch panels to see data visualizations

---

## 3. Enhanced Loading & Thinking Animation

### 3.1 Thinking State Animation
- [ ] Improve "thinking" animation when chatbot is processing
- [ ] Consider animated typing indicators, pulsing dots, or other modern loading patterns
- [ ] Show clear visual feedback that the system is working
- [ ] Add smooth transitions between thinking and response states
- [ ] Add What tool used and the result of the tool too when opened.

### 3.2 Tool Execution Feedback
- [ ] Show visual indicator when tools are being invoked (e.g., "Fetching energy data...")
- [ ] Provide context about what the chatbot is doing during longer operations

### 3.3 Tool Visibility & Transparency
- [ ] After chatbot completes response, allow users to expand/view which tools were used
- [ ] Display tool names that were executed (e.g., "get_room_telemetry", "get_energy_rankings")
- [ ] Show tool execution results/raw data in expandable section
- [ ] Provide toggle or accordion to view tool details without cluttering the main conversation
- [ ] Help users understand how the chatbot gathered information to generate the response

---

## 4. Visual Design & Alignment

### 4.1 Design System Consistency
- [ ] Align chat interface colors with existing OcuTemp palette (Tailwind classes)
- [ ] Use consistent typography, spacing, and border radius throughout
- [ ] Match card styles, shadows, and hover states to dashboard/room-management pages
- [ ] Ensure chat sidebar fits naturally with the overall application design

### 4.2 Message Styling
- [ ] Style user messages distinctly from assistant messages
- [ ] Add proper padding, margins, and background colors
- [ ] Ensure text is readable and well-formatted
- [ ] Style code blocks, lists, and emphasis properly

### 4.3 Graph/Chart Integration
- [ ] Design inline chart containers that match chat message styling
- [ ] Add proper labels, titles, and legends to charts
- [ ] Ensure charts are responsive and properly sized within chat flow
- [ ] Style Chart.js visualizations to match OcuTemp color scheme

### 4.4 Mobile & Responsive Design
- [ ] Ensure chat interface is fully responsive
- [ ] Test on various screen sizes
- [ ] Optimize input bar and message layout for mobile devices
- [ ] Ensure graphs scale appropriately on smaller screens

---

## 5. Performance & Optimization

### 5.1 Rendering Optimization
- [ ] Implement virtual scrolling for long chat histories if needed
- [ ] Use `trackBy` functions in `*ngFor` loops for message rendering
- [ ] Lazy load or defer Chart.js initialization until charts are in viewport
- [ ] Optimize re-rendering when new messages arrive (use `OnPush` change detection)

### 5.2 Chart Performance
- [ ] Ensure Chart.js instances are properly destroyed when messages scroll out of view
- [ ] Reuse chart configurations where possible
- [ ] Implement chart data caching to avoid redundant processing
- [ ] Defer chart animations on initial load for faster perceived performance

### 5.3 Memory Management
- [ ] Prevent memory leaks from chart instances in long conversations
- [ ] Clean up event listeners when message components are destroyed
- [ ] Implement conversation history limits if needed (e.g., keep last 50 messages in DOM)
- [ ] Monitor and optimize bundle size if new dependencies are needed

### 5.4 Loading Performance
- [ ] Optimize initial page load time
- [ ] Implement skeleton screens for chat messages while loading
- [ ] Ensure smooth scrolling performance even with multiple charts rendered
- [ ] Test performance with long conversations (20+, 50+, 100+ messages)

---

## 6. User Experience Improvements

### 5.1 Chat History
- [ ] Display full conversation history in scrollable view
- [ ] Auto-scroll to bottom when new messages arrive
- [ ] Allow users to scroll up to view previous messages

### 5.2 Suggested Prompts
- [ ] Keep role-aware suggestion chips
- [ ] Position suggestions appropriately (above input or in empty state)
- [ ] Update suggestions based on conversation context if feasible

### 5.3 Error Handling
- [ ] Display user-friendly error messages within the chat flow
- [ ] Maintain consistent error styling
- [ ] Allow retry or fallback when errors occur

---

## Implementation Notes

- **No backend/logic changes**: This is a UI/UX redesign only
- **Preserve existing functionality**: All current features must continue working
- **Components affected**: Primarily `OcuGuidePage`, `OcuGuideConversationComponent`, `OcuGuideReportComponent`, and related templates
- **Current architecture**: Two separate panels (chat conversation + evidence report) that need merging into single chat flow
- **Services unchanged**: `ChatService`, `ChatToolsService`, and API remain as-is
- **Focus areas**: Component templates, styles, and presentation logic only
- **Key change**: Inline graphs/charts within assistant message bubbles instead of separate "Report" panel
- **Performance priority**: Optimize for smooth rendering, Chart.js lifecycle management, and memory efficiency
- **Testing approach**: Verify functionality by running `ng serve` or `npm run build` only — no test files will be added and no test runs required

---

## Success Criteria

✅ Chat responds naturally to basic questions without forcing tool usage  
✅ Graphs appear inline with text explanations in the conversation flow  
✅ Single unified chat interface replaces the two-panel design  
✅ Enhanced, modern "thinking" animation during processing  
✅ Visual design matches the rest of the OcuTemp application  
✅ Chat interface is responsive and mobile-friendly  
✅ All existing chat functionality remains operational  
✅ No performance degradation with long conversations (50+ messages)  
✅ Chart.js instances properly managed (no memory leaks)  
✅ Smooth scrolling and interactions even with multiple charts displayed  
✅ Fast initial load time and perceived performance
