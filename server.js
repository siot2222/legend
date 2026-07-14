const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); // 파일 읽기 모듈 추가

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 기본 퀴즈 데이터 (CSV를 못 불러올 때를 대비한 백업)
let quizData = [
    { type: "OX", question: "토마토는 채소다.", answer: "O" }
];

// CSV 파일을 파싱해서 quizData에 넣는 함수
function loadQuizFromCSV() {
    const csvPath = path.join(__dirname, 'quiz.csv');
    if (fs.existsSync(csvPath)) {
        try {
            const fileContent = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
            const lines = fileContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);
            
            const loadedData = [];
            // 첫 줄(헤더)을 제외하고 둘째 줄부터 파싱
            for (let i = 1; i < lines.length; i++) {
                // 콤마(,)로 분할하되, 따옴표 안에 있는 콤마는 무시하는 정규식
                const row = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(',');
                if (row.length < 3) continue;

                const type = row[0].replace(/"/g, '').trim(); // OX, CHOICE, SHORT
                const question = row[1].replace(/"/g, '').trim();
                const rawAnswer = row[2].replace(/"/g, '').trim();

                const quizItem = { type, question };

                if (type === 'CHOICE') {
                    // 객관식일 경우 3번째 열부터 끝까지는 보기 목록으로 취급
                    const options = row.slice(3).map(opt => opt.replace(/"/g, '').trim()).filter(opt => opt !== "");
                    quizItem.options = options;
                    quizItem.answer = parseInt(rawAnswer); // 정답 번호 (0, 1, 2...)
                } else {
                    quizItem.answer = rawAnswer; // OX 또는 주관식 정답 문자열
                }

                loadedData.push(quizItem);
            }
            if (loadedData.length > 0) {
                quizData = loadedData;
                console.log(`📊 quiz.csv에서 총 ${quizData.length}개의 문제를 성공적으로 불러왔습니다!`);
            }
        } catch (err) {
            console.error("⚠️ quiz.csv 파일을 읽는 중 오류가 발생하여 기본 퀴즈로 대체합니다:", err);
        }
    } else {
        console.log("ℹ️ quiz.csv 파일이 없습니다. 기본 예시 문제로 진행합니다.");
    }
}

// 서버 시작 시 CSV 자동 로드
loadQuizFromCSV();

let gameState = {
    players: {},
    currentQuestionIndex: -1,
    isPlaying: false,
    timeLeft: 20,
    timerInterval: null,
    isRoundEnded: false
};

io.on('connection', (socket) => {
    socket.on('joinGame', (nickname) => {
        gameState.players[socket.id] = { nickname, score: 0, currentAnswer: null, isCorrect: false };
        io.emit('updatePlayers', Object.values(gameState.players));
    });

    socket.on('nextQuestion', () => {
        if (gameState.timerInterval) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
        }
        
        gameState.currentQuestionIndex++;
        gameState.isRoundEnded = false;
        
        for (let id in gameState.players) {
            gameState.players[id].currentAnswer = null;
            gameState.players[id].isCorrect = false;
        }

        if (gameState.currentQuestionIndex >= quizData.length) {
            const ranking = Object.values(gameState.players).sort((a, b) => b.score - a.score);
            io.emit('gameOver', ranking);
            gameState.currentQuestionIndex = -1;
            gameState.isPlaying = false;
        } else {
            gameState.timeLeft = 20;
            const currentQuestion = quizData[gameState.currentQuestionIndex];
            
            const clientQuestion = {
                type: currentQuestion.type,
                question: currentQuestion.question,
                options: currentQuestion.options || null,
                index: gameState.currentQuestionIndex,
                total: quizData.length
            };

            io.emit('newQuestion', clientQuestion);
            io.emit('timerUpdate', gameState.timeLeft);

            gameState.timerInterval = setInterval(() => {
                gameState.timeLeft--;
                io.emit('timerUpdate', gameState.timeLeft);

                if (gameState.timeLeft <= 0) {
                    clearInterval(gameState.timerInterval);
                    gameState.timerInterval = null;
                    revealResults();
                }
            }, 1000);
        }
    });

// 참여자: 답 제출 (이 부분을 통째로 교체하세요!)
    socket.on('submitAnswer', (userAnswer) => {
        const player = gameState.players[socket.id];
        // 이미 냈거나, 현재 진행중인 문제가 없거나, 이미 이번 라운드가 끝났으면 무시
        if (!player || player.currentAnswer !== null || gameState.isRoundEnded) return; 

        player.currentAnswer = userAnswer;
        
        // 정답 채점 검증
        const currentQuestion = quizData[gameState.currentQuestionIndex];
        let correct = false;

        // 문자열 및 숫자 공백 제거 후 비교
        const cleanUserAnswer = String(userAnswer).trim().toLowerCase();
        const cleanCorrectAnswer = String(currentQuestion.answer).trim().toLowerCase();

        if (currentQuestion.type === 'OX' || currentQuestion.type === 'SHORT') {
            correct = (cleanUserAnswer === cleanCorrectAnswer);
        } else if (currentQuestion.type === 'CHOICE') {
            // 사용자가 선택한 보기가 번호(index)일 수도 있고, 보기 텍스트 자체일 수도 있으므로 둘 다 대응하도록 방어 코드 작성
            const isIndexMatch = (cleanUserAnswer === cleanCorrectAnswer);
            
            // 혹시 클라이언트에서 인덱스 번호가 아니라 '서울' 같은 텍스트 자체를 보냈을 경우를 대비한 2중 체크
            const correctText = currentQuestion.options[parseInt(currentQuestion.answer)];
            const isTextMatch = correctText && (cleanUserAnswer === String(correctText).trim().toLowerCase());

            correct = isIndexMatch || isTextMatch;
        }

        player.isCorrect = correct;
        if (correct) {
            // 남은 시간에 따른 가산점 보너스 (빨리 낼수록 점수 가산)
            player.score += 10 + gameState.timeLeft; 
        }

        // 호스트에게 실시간으로 누가 제출했는지 업데이트 전달
        const playersArr = Object.values(gameState.players);
        io.emit('playerSubmitted', playersArr);

        // 참여자 전원이 답을 냈는지 체크
        const totalPlayers = playersArr.length;
        const submittedCount = playersArr.filter(p => p.currentAnswer !== null).length;

        if (totalPlayers > 0 && submittedCount === totalPlayers && !gameState.isRoundEnded) {
            if (gameState.timerInterval) {
                clearInterval(gameState.timerInterval);
                gameState.timerInterval = null;
            }
            revealResults();
        }
    });

    function revealResults() {
        if (gameState.isRoundEnded) return;
        gameState.isRoundEnded = true;

        const currentQuestion = quizData[gameState.currentQuestionIndex];
        
        for (let id in gameState.players) {
            const p = gameState.players[id];
            io.to(id).emit('roundResult', {
                isCorrect: p.isCorrect,
                correctAnswer: currentQuestion.type === 'CHOICE' ? currentQuestion.options[currentQuestion.answer] : currentQuestion.answer,
                score: p.score
            });
        }

        const ranking = Object.values(gameState.players).sort((a, b) => b.score - a.score);
        io.emit('hostRoundResult', {
            correctAnswer: currentQuestion.type === 'CHOICE' ? currentQuestion.options[currentQuestion.answer] : currentQuestion.answer,
            ranking: ranking
        });
    }

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        io.emit('updatePlayers', Object.values(gameState.players));
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 카훗형 서버 구동 중: http://localhost:${PORT}`));